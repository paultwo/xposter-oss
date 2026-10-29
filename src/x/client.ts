import { markdownToContentState } from "../lib/article";
import { scrub } from "../lib/log";
import { scopesAreExact } from "../lib/scopes";

export type XFailure =
  | { type: "unauthorized" }
  | { type: "rate_limit"; resetAt: number | null }
  | { type: "credits" }
  | { type: "rejected"; detail: string }
  | { type: "ambiguous"; detail: string };

export type XResult<T> = { type: "ok"; value: T } | XFailure;

export const X_TIMEOUT_DETAIL = "The request to X timed out.";

export type TokenBundle = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
};

const ARTICLE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function endpoint(env: Env, path: string): string {
  return `${env.X_API_BASE.replace(/\/$/, "")}${path}`;
}

export function xFetchTimeoutMs(env: Env): number {
  const parsed = Number(env.X_FETCH_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15000;
}

async function interpret(response: Response): Promise<XResult<Response>> {
  if (response.status === 401) return { type: "unauthorized" };
  if (response.status === 429) {
    const reset = response.headers.get("x-rate-limit-reset");
    const resetAt = reset ? Number(reset) * 1000 : null;
    return {
      type: "rate_limit",
      resetAt: Number.isFinite(resetAt) ? resetAt : null,
    };
  }
  if (response.status === 402) return { type: "credits" };
  if (response.status >= 500)
    return { type: "ambiguous", detail: `X returned ${response.status}.` };
  if (response.status >= 400) {
    const text = scrub(await response.text());
    return {
      type: "rejected",
      detail: text.slice(0, 240) || `X returned ${response.status}.`,
    };
  }
  return { type: "ok", value: response };
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "TimeoutError"
  );
}

async function request(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<XResult<Response>> {
  const signal = AbortSignal.timeout(xFetchTimeoutMs(env));
  try {
    const response = await fetch(endpoint(env, path), {
      ...init,
      signal,
    });
    return interpret(response);
  } catch (error) {
    const timedOut = isTimeout(error) || isTimeout(signal.reason);
    return {
      type: "ambiguous",
      detail: timedOut ? X_TIMEOUT_DETAIL : "The request to X did not finish.",
    };
  }
}

function basicAuth(env: Env): string {
  return btoa(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`);
}

async function readJson(response: Response): Promise<XResult<unknown>> {
  try {
    return { type: "ok", value: await response.json() };
  } catch {
    return {
      type: "ambiguous",
      detail: "X returned a response that was not JSON.",
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

export async function exchangeCode(
  env: Env,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<XResult<TokenBundle>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: env.X_CLIENT_ID,
  });
  const response = await request(env, "/2/oauth2/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${basicAuth(env)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (response.type !== "ok") return response;
  return acceptToken(env, response.value);
}

export async function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<XResult<TokenBundle>> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.X_CLIENT_ID,
  });
  const response = await request(env, "/2/oauth2/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${basicAuth(env)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (response.type !== "ok") return response;
  return acceptToken(env, response.value);
}

async function acceptToken(
  env: Env,
  response: Response,
): Promise<XResult<TokenBundle>> {
  const token = await readToken(response);
  if (token.type !== "ok") return token;
  if (!scopesAreExact(token.value.scope)) {
    await revokeToken(env, token.value.refreshToken);
    return { type: "rejected", detail: "scope" };
  }
  return token;
}

async function readToken(response: Response): Promise<XResult<TokenBundle>> {
  const json = await readJson(response);
  if (json.type !== "ok") return json;
  const record = asRecord(json.value);
  const accessToken = record?.access_token;
  const refreshToken = record?.refresh_token;
  const expiresIn = record?.expires_in;
  const scope = record?.scope;
  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    typeof scope !== "string"
  ) {
    return {
      type: "ambiguous",
      detail: "X token response was missing fields.",
    };
  }
  return {
    type: "ok",
    value: {
      accessToken,
      refreshToken,
      expiresIn: typeof expiresIn === "number" ? expiresIn : 7200,
      scope,
    },
  };
}

export async function revokeToken(env: Env, token: string): Promise<void> {
  const body = new URLSearchParams({
    token,
    token_type_hint: "refresh_token",
    client_id: env.X_CLIENT_ID,
  });
  await request(env, "/2/oauth2/revoke", {
    method: "POST",
    headers: {
      authorization: `Basic ${basicAuth(env)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

export type XAccount = {
  id: string;
  username: string;
  displayName: string | null;
  profileImageUrl: string | null;
  subscriptionType: string | null;
};

export async function fetchMe(
  env: Env,
  accessToken: string,
): Promise<XResult<XAccount>> {
  const response = await request(
    env,
    "/2/users/me?user.fields=profile_image_url,name,subscription_type",
    {
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (response.type !== "ok") return response;
  const json = await readJson(response.value);
  if (json.type !== "ok") return json;
  const data = asRecord(asRecord(json.value)?.data);
  const id = data?.id;
  const username = data?.username;
  if (typeof id !== "string" || typeof username !== "string") {
    return {
      type: "ambiguous",
      detail: "X account response was missing fields.",
    };
  }
  const profileImageUrl =
    typeof data?.profile_image_url === "string" ? data.profile_image_url : null;
  const displayName = typeof data?.name === "string" ? data.name : null;
  const subscriptionType =
    typeof data?.subscription_type === "string" ? data.subscription_type : null;
  return {
    type: "ok",
    value: { id, username, displayName, profileImageUrl, subscriptionType },
  };
}

export async function fetchPostAuthor(
  env: Env,
  accessToken: string,
  postId: string,
): Promise<XResult<{ authorId: string }>> {
  if (!/^\d{1,32}$/.test(postId)) {
    return { type: "rejected", detail: "Post id is not valid." };
  }
  const response = await request(
    env,
    `/2/tweets/${postId}?tweet.fields=author_id`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (response.type !== "ok") return response;
  const json = await readJson(response.value);
  if (json.type !== "ok") return json;
  const authorId = asRecord(asRecord(json.value)?.data)?.author_id;
  if (typeof authorId !== "string" || authorId.length === 0) {
    return { type: "ambiguous", detail: "X did not return the post's author." };
  }
  return { type: "ok", value: { authorId } };
}

export async function createPost(
  env: Env,
  accessToken: string,
  text: string,
  mediaIds: string[],
  replyTo: string | null,
): Promise<XResult<{ id: string }>> {
  const payload: Record<string, unknown> = { text };
  if (mediaIds.length > 0) payload.media = { media_ids: mediaIds };
  if (replyTo) payload.reply = { in_reply_to_tweet_id: replyTo };
  const response = await request(env, "/2/tweets", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (response.type !== "ok") return response;
  const json = await readJson(response.value);
  if (json.type !== "ok") return json;
  const id = asRecord(asRecord(json.value)?.data)?.id;
  if (typeof id !== "string")
    return { type: "ambiguous", detail: "X did not return a post id." };
  return { type: "ok", value: { id } };
}

export async function uploadMedia(
  env: Env,
  accessToken: string,
  bytes: Uint8Array,
  mime: string,
): Promise<XResult<{ id: string }>> {
  const category = mime === "image/gif" ? "tweet_gif" : "tweet_image";
  const form = new FormData();
  form.set("media", new Blob([bytes], { type: mime }), "upload");
  form.set("media_category", category);
  const response = await request(env, "/2/media/upload", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (response.type !== "ok") return response;
  const json = await readJson(response.value);
  if (json.type !== "ok") return json;
  const record = asRecord(json.value);
  const id = asRecord(record?.data)?.id ?? record?.id;
  if (typeof id !== "string")
    return { type: "ambiguous", detail: "X did not return a media id." };
  return { type: "ok", value: { id } };
}

export async function setAltText(
  env: Env,
  accessToken: string,
  mediaId: string,
  altText: string,
): Promise<XResult<true>> {
  const response = await request(env, "/2/media/metadata", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: mediaId,
      metadata: { alt_text: { text: altText } },
    }),
  });
  if (response.type !== "ok") return response;
  return { type: "ok", value: true };
}

export async function createArticleDraft(
  env: Env,
  accessToken: string,
  title: string,
  markdown: string,
): Promise<XResult<{ id: string }>> {
  const response = await request(env, "/2/articles/draft", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title,
      content_state: markdownToContentState(markdown),
    }),
  });
  if (response.type !== "ok") return response;
  const json = await readJson(response.value);
  if (json.type !== "ok") return json;
  const id = asRecord(asRecord(json.value)?.data)?.id;
  if (typeof id !== "string" || !ARTICLE_ID.test(id)) {
    return { type: "ambiguous", detail: "X did not return an article id." };
  }
  return { type: "ok", value: { id } };
}

export async function publishArticle(
  env: Env,
  accessToken: string,
  articleId: string,
): Promise<XResult<{ postId: string }>> {
  if (!ARTICLE_ID.test(articleId))
    return { type: "rejected", detail: "Article id is not valid." };
  const response = await request(env, `/2/articles/${articleId}/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (response.type !== "ok") return response;
  const json = await readJson(response.value);
  if (json.type !== "ok") return json;
  const data = asRecord(asRecord(json.value)?.data);
  const postId = data?.post_id ?? data?.id;
  if (typeof postId !== "string")
    return {
      type: "ambiguous",
      detail: "X did not return a post id for the article.",
    };
  return { type: "ok", value: { postId } };
}
