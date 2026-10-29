import { AppError } from "../items/model";
import { randomToken, sha256Hex, timingSafeEqualText } from "../lib/crypto";
import { ulid } from "../lib/ulid";

const NAME_RE = /^[a-z0-9-]{2,40}$/;

// Immutable id for the Worker-secret bot. A row with this primary key is
// inserted by migration 0004 so a minted token cannot claim it.
export const ENV_INTAKE_ID = "env:intake";

export async function resolveBearer(
  env: Env,
  presented: string,
  now: number,
): Promise<{ id: string; name: string } | null> {
  if (!presented) return null;
  const hash = await sha256Hex(presented);
  const row = await env.DB.prepare(
    "SELECT id, name, token_sha256, revoked_at FROM intake_tokens WHERE token_sha256 = ?",
  )
    .bind(hash)
    .first<{
      id: string;
      name: string;
      token_sha256: string;
      revoked_at: number | null;
    }>();
  const stored = row?.token_sha256 ?? "0".repeat(64);
  const matched = timingSafeEqualText(hash, stored);
  if (row && row.revoked_at === null && matched) {
    await env.DB.prepare(
      "UPDATE intake_tokens SET last_used_at = ? WHERE id = ?",
    )
      .bind(now, row.id)
      .run();
    return { id: row.id, name: row.name };
  }
  if (env.INTAKE_TOKEN) {
    const secretHash = await sha256Hex(env.INTAKE_TOKEN);
    if (timingSafeEqualText(hash, secretHash))
      return { id: ENV_INTAKE_ID, name: "x-drafts" };
  } else {
    void timingSafeEqualText(hash, "0".repeat(64));
  }
  return null;
}

export async function consumeQuota(
  env: Env,
  tokenId: string,
  now: number,
): Promise<void> {
  const bucket = Math.floor(now / 3_600_000);
  await env.DB.prepare(
    `INSERT INTO intake_usage (token_id, hour_bucket, count) VALUES (?, ?, 1)
     ON CONFLICT (token_id, hour_bucket) DO UPDATE SET count = count + 1`,
  )
    .bind(tokenId, bucket)
    .run();
  const row = await env.DB.prepare(
    "SELECT count AS n FROM intake_usage WHERE token_id = ? AND hour_bucket = ?",
  )
    .bind(tokenId, bucket)
    .first<{ n: number }>();
  if ((row?.n ?? 0) > 60)
    throw new AppError(429, "This intake token is over 60 requests this hour.");
}

export async function createNamedToken(
  env: Env,
  name: string,
  now: number,
): Promise<string> {
  if (!NAME_RE.test(name))
    throw new AppError(
      422,
      "Token name must be 2 to 40 letters, numbers, or hyphens.",
    );
  const raw = randomToken(32);
  let id = ulid(now);
  if (id === ENV_INTAKE_ID) id = ulid(now + 1);
  try {
    await env.DB.prepare(
      "INSERT INTO intake_tokens (id, name, token_sha256, created_at, revoked_at, last_used_at) VALUES (?, ?, ?, ?, NULL, NULL)",
    )
      .bind(id, name, await sha256Hex(raw), now)
      .run();
  } catch {
    throw new AppError(422, "That token name is already in use.");
  }
  return raw;
}

export async function revokeNamedToken(
  env: Env,
  id: string,
  now: number,
): Promise<void> {
  const result = await env.DB.prepare(
    "UPDATE intake_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  )
    .bind(now, id)
    .run();
  if ((result.meta.changes ?? 0) !== 1)
    throw new AppError(404, "That token is not active.");
}

export async function listNamedTokens(env: Env): Promise<
  Array<{
    id: string;
    name: string;
    createdAt: number;
    revokedAt: number | null;
    lastUsedAt: number | null;
  }>
> {
  const rows = await env.DB.prepare(
    "SELECT id, name, created_at, revoked_at, last_used_at FROM intake_tokens ORDER BY created_at DESC",
  ).all<{
    id: string;
    name: string;
    created_at: number;
    revoked_at: number | null;
    last_used_at: number | null;
  }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  }));
}
