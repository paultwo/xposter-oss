import { env, SELF } from "cloudflare:test";
import { expect } from "vitest";
import { encryptString } from "../../src/lib/crypto";
import { signAccess } from "./mock-x";

export const ORIGIN = "https://poster.example.com";
export const PNG = btoa(
  String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
);

export type Session = { jwt: string; csrf: string; cookie: string };
export type ItemJson = {
  id: string;
  status: string;
  review_stage: string;
  notes: string | null;
  source: string;
  source_ref: string | null;
  content_hash: string;
  approved_hash: string | null;
  scheduled_at: number | null;
  last_error: string | null;
  needs_reason: string | null;
  x_article_id: string | null;
  missed: boolean;
  segments: Array<{
    position: number;
    text: string;
    x_post_id: string | null;
    media: Array<{ alt_text: string }>;
  }>;
};

export function cookieHeader(response: Response, previous = ""): string {
  const parts = previous ? previous.split("; ").filter(Boolean) : [];
  const rows =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  for (const row of rows) {
    const pair = row.split(";")[0];
    if (!pair) continue;
    const name = pair.split("=")[0] ?? "";
    const kept = parts.filter((part) => !part.startsWith(`${name}=`));
    kept.push(pair);
    parts.length = 0;
    parts.push(...kept);
  }
  return parts.join("; ");
}

export async function asUser(): Promise<Session> {
  const jwt = await signAccess({ email: "you@example.com" });
  const response = await SELF.fetch(`${ORIGIN}/`, {
    headers: { "cf-access-jwt-assertion": jwt },
  });
  return {
    jwt,
    csrf: response.headers.get("x-csrf-token") ?? "",
    cookie: cookieHeader(response),
  };
}

export function auth(
  session: Session,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "cf-access-jwt-assertion": session.jwt,
    cookie: session.cookie,
    "x-csrf-token": session.csrf,
    ...extra,
  };
}

export async function send(
  session: Session,
  path: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: auth(
      session,
      body === undefined ? {} : { "content-type": "application/json" },
    ),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function createItem(
  session: Session,
  body: unknown,
): Promise<ItemJson> {
  const response = await send(session, "/api/items", "POST", body);
  expect(response.status).toBe(201);
  const json = (await response.json()) as { item: ItemJson };
  return json.item;
}

export async function readItem(
  session: Session,
  id: string,
): Promise<ItemJson> {
  const response = await send(session, `/api/items/${id}`, "GET");
  expect(response.status).toBe(200);
  return ((await response.json()) as { item: ItemJson }).item;
}

export async function approveAndSchedule(
  session: Session,
  item: ItemJson,
  when = Date.now() - 1000,
): Promise<void> {
  const approved = await send(
    session,
    `/api/items/${item.id}/approve`,
    "POST",
    {
      expected_hash: item.content_hash,
    },
  );
  expect(approved.status).toBe(200);
  const allowed = when > Date.now() ? when : Date.now() + 120_000;
  const scheduled = await send(
    session,
    `/api/items/${item.id}/schedule`,
    "POST",
    { scheduled_at: allowed },
  );
  expect(scheduled.status).toBe(200);
  if (when <= Date.now()) {
    await env.DB.prepare("UPDATE items SET scheduled_at = ? WHERE id = ?")
      .bind(when, item.id)
      .run();
  }
}

export async function connectX(
  expiresAt = Date.now() + 60 * 60 * 1000,
): Promise<void> {
  const access = await encryptString(env.TOKEN_ENC_KEY, "stored-access-token");
  const refresh = await encryptString(
    env.TOKEN_ENC_KEY,
    "stored-refresh-token",
  );
  await env.DB.prepare("DELETE FROM oauth_account WHERE id = 1").run();
  await env.DB.prepare(
    `INSERT INTO oauth_account (
      id, x_user_id, x_username, access_token_enc, refresh_token_enc, iv_access, iv_refresh,
      expires_at, scopes, updated_at, needs_reconnect, lease_until, lease_id
    ) VALUES (1, '999', 'exampleuser', ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`,
  )
    .bind(
      access.cipher,
      refresh.cipher,
      access.iv,
      refresh.iv,
      expiresAt,
      "tweet.read tweet.write users.read media.write offline.access",
      Date.now(),
    )
    .run();
}

export async function intakeCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers = await intakeHeaders();
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers:
      body === undefined
        ? headers
        : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function postForm(
  session: Session,
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: auth(session, {
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: new URLSearchParams({ csrf: session.csrf, ...fields }).toString(),
    redirect: "manual",
  });
}

export async function resetPostingGate(): Promise<void> {
  await env.DB.prepare(
    "UPDATE app_settings SET posting_paused = 0, posting_blocked_since = NULL, paused_at = NULL, paused_by = NULL WHERE id = 1",
  ).run();
}

export async function intakeHeaders(
  bearer = "test-intake-token",
  audience = "test-audience",
): Promise<Record<string, string>> {
  const jwt = await signAccess(
    { common_name: "x-poster-intake" },
    { audience },
  );
  return {
    "cf-access-jwt-assertion": jwt,
    authorization: `Bearer ${bearer}`,
  };
}
