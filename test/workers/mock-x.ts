import { fetchMock } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { SCOPE_STRING } from "../../src/lib/scopes";

type TweetCall = { text: string; replyTo: string | null; mediaIds: string[] };
type MockReply = {
  statusCode: number;
  data: string;
  responseOptions?: { headers: Record<string, string> };
};

export const xstate = {
  paths: [] as string[],
  tweets: [] as TweetCall[],
  alts: [] as string[],
  articleTitles: [] as string[],
  publishes: [] as string[],
  tokenScopes: SCOPE_STRING,
  username: "exampleuser",
  displayName: "Test Account",
  userId: "999",
  subscriptionType: "None",
  defaultPostAuthor: "999",
  postAuthors: {} as Record<string, string>,
  meStatus: 200,
  tokenStatus: 200,
  onTweet: null as null | ((index: number, tweet: TweetCall) => MockReply),
  dropTweet: null as null | number,
};

let privateKey: CryptoKey | null = null;
let installed = false;

export function resetX(): void {
  xstate.paths = [];
  xstate.tweets = [];
  xstate.alts = [];
  xstate.articleTitles = [];
  xstate.publishes = [];
  xstate.tokenScopes = SCOPE_STRING;
  xstate.username = "exampleuser";
  xstate.displayName = "Test Account";
  xstate.userId = "999";
  xstate.subscriptionType = "None";
  xstate.defaultPostAuthor = "999";
  xstate.postAuthors = {};
  xstate.meStatus = 200;
  xstate.tokenStatus = 200;
  xstate.onTweet = null;
  xstate.dropTweet = null;
}

export async function signAccess(
  claims: Record<string, string | number>,
  options: { exp?: string | number; audience?: string } = {},
): Promise<string> {
  if (!privateKey) throw new Error("mock keys are not ready");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://team.example.invalid")
    .setAudience(options.audience ?? "test-audience")
    .setExpirationTime(options.exp ?? "2h")
    .sign(privateKey);
}

function textBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return "";
}

function jsonReply(
  statusCode: number,
  value: unknown,
  headers?: Record<string, string>,
): MockReply {
  return {
    statusCode,
    data: JSON.stringify(value),
    responseOptions: {
      headers: { "content-type": "application/json", ...headers },
    },
  };
}

function handleX(opts: {
  path: string;
  method: string;
  body?: unknown;
}): MockReply {
  const path = opts.path.split("?")[0] ?? opts.path;
  xstate.paths.push(path);
  if (path.startsWith("/2/dm") || path.startsWith("/2/chat"))
    return { statusCode: 404, data: "not found" };
  if (path === "/2/oauth2/token" || path === "/2/oauth2/revoke") {
    if (xstate.tokenStatus !== 200)
      return { statusCode: xstate.tokenStatus, data: "" };
    return jsonReply(200, {
      access_token: "refreshed-access-token",
      refresh_token: "refreshed-refresh-token",
      expires_in: 7200,
      scope: xstate.tokenScopes,
    });
  }
  if (path === "/2/users/me") {
    if (xstate.meStatus !== 200)
      return { statusCode: xstate.meStatus, data: "" };
    return jsonReply(200, {
      data: {
        id: xstate.userId,
        username: xstate.username,
        name: xstate.displayName,
        subscription_type: xstate.subscriptionType,
      },
    });
  }
  const tweetLookup = path.match(/^\/2\/tweets\/(\d+)$/);
  if (tweetLookup && opts.method === "GET") {
    const id = tweetLookup[1] ?? "";
    const author = xstate.postAuthors[id] ?? xstate.defaultPostAuthor;
    if (!author) return { statusCode: 404, data: "not found" };
    return jsonReply(200, { data: { id, author_id: author } });
  }
  if (path === "/2/tweets" && opts.method === "POST") {
    const raw = textBody(opts.body);
    let parsed: {
      text?: string;
      reply?: { in_reply_to_tweet_id?: string };
      media?: { media_ids?: string[] };
    } = {};
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }
    const tweet: TweetCall = {
      text: parsed.text ?? "",
      replyTo: parsed.reply?.in_reply_to_tweet_id ?? null,
      mediaIds: parsed.media?.media_ids ?? [],
    };
    const index = xstate.tweets.length;
    xstate.tweets.push(tweet);
    if (xstate.dropTweet === index) return { statusCode: 500, data: "" };
    if (xstate.onTweet) return xstate.onTweet(index, tweet);
    return jsonReply(201, { data: { id: String(1000 + index) } });
  }
  if (path === "/2/media/upload")
    return jsonReply(200, { data: { id: `med_${xstate.paths.length}` } });
  if (path === "/2/media/metadata") {
    try {
      const parsed = JSON.parse(textBody(opts.body)) as {
        metadata?: { alt_text?: { text?: string } };
      };
      xstate.alts.push(parsed.metadata?.alt_text?.text ?? "");
    } catch {
      xstate.alts.push("");
    }
    return jsonReply(200, {});
  }
  if (path === "/2/articles/draft") {
    try {
      const parsed = JSON.parse(textBody(opts.body)) as { title?: string };
      xstate.articleTitles.push(parsed.title ?? "");
    } catch {
      xstate.articleTitles.push("");
    }
    return jsonReply(200, { data: { id: "art_1" } });
  }
  if (path.startsWith("/2/articles/") && path.endsWith("/publish")) {
    xstate.publishes.push(path);
    return jsonReply(200, { data: { post_id: "555" } });
  }
  return { statusCode: 404, data: "not found" };
}

export async function installMocks(): Promise<void> {
  if (installed) return;
  const keys = await generateKeyPair("RS256", { extractable: true });
  privateKey = keys.privateKey;
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  fetchMock
    .get("https://access.test")
    .intercept({ path: "/cdn-cgi/access/certs", method: "GET" })
    .reply(200, JSON.stringify({ keys: [jwk] }), {
      headers: { "content-type": "application/json" },
    })
    .persist();
  fetchMock
    .get("https://api.x.com")
    .intercept({ path: () => true, method: () => true })
    .reply((opts) => handleX(opts))
    .persist();
  installed = true;
}
