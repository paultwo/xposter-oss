import { isImageMime } from "../items/media";
import { rowChanges } from "../items/store";
import { decryptString, encryptString } from "../lib/crypto";
import { scopesAreExact } from "../lib/scopes";
import { isBlockedHost, readLimitedStream } from "../lib/ssrf";
import {
  clearDisconnected,
  clearUnpostedApprovals,
  disconnectWindow,
  markMissedDue,
  noteDisconnected,
} from "../posting/control";
import { settleIdleAccountSwitches } from "../posting/idle";
import {
  fetchMe,
  refreshAccessToken,
  revokeToken,
  type TokenBundle,
} from "./client";

const REFRESH_LEASE_MS = 30_000;

export type PublicAccount = {
  connected: boolean;
  username: string | null;
  displayName: string | null;
  subscriptionType: string | null;
  userId: string | null;
  scopes: string | null;
  expiresAt: number | null;
  needsReconnect: boolean;
  updatedAt: number | null;
  avatar: boolean;
};

type AccountRow = {
  x_user_id: string | null;
  x_username: string | null;
  display_name: string | null;
  subscription_type: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  iv_access: string | null;
  iv_refresh: string | null;
  expires_at: number | null;
  scopes: string | null;
  updated_at: number | null;
  needs_reconnect: number;
  lease_until: number | null;
  lease_id: string | null;
  avatar_r2_key: string | null;
};

function toPublic(row: AccountRow | null): PublicAccount {
  if (!row?.x_username || !row.access_token_enc) {
    return {
      connected: false,
      username: null,
      displayName: null,
      subscriptionType: null,
      userId: null,
      scopes: null,
      expiresAt: null,
      needsReconnect: false,
      updatedAt: null,
      avatar: false,
    };
  }
  return {
    connected: true,
    username: row.x_username,
    displayName: row.display_name,
    subscriptionType: row.subscription_type,
    userId: row.x_user_id,
    scopes: row.scopes,
    expiresAt: row.expires_at,
    needsReconnect: row.needs_reconnect === 1,
    updatedAt: row.updated_at,
    avatar: Boolean(row.avatar_r2_key),
  };
}

async function readRow(env: Env): Promise<AccountRow | null> {
  return env.DB.prepare(
    "SELECT * FROM oauth_account WHERE id = 1",
  ).first<AccountRow>();
}

export async function publicAccount(env: Env): Promise<PublicAccount> {
  return toPublic(await readRow(env));
}

export async function saveTokenBundle(
  env: Env,
  bundle: TokenBundle,
  user: {
    id: string;
    username: string;
    displayName: string | null;
    subscriptionType: string | null;
  },
  now: number,
): Promise<void> {
  if (!scopesAreExact(bundle.scope)) throw new Error("refusing token");
  const previous = await readRow(env);
  const switching = Boolean(
    previous?.x_user_id && previous.x_user_id !== user.id,
  );
  if (switching && previous) {
    await revokeStoredRefresh(env, previous);
    await markMissedDue(env, now);
  }
  // A disconnect deletes the oauth row, so the next connect has no previous
  // id to compare. Clear any unposted approval bound to a different user
  // before the new token is stored.
  await clearUnpostedApprovals(env, user.id, now);
  await settleIdleAccountSwitches(env, now);
  const access = await encryptString(env.TOKEN_ENC_KEY, bundle.accessToken);
  const refresh = await encryptString(env.TOKEN_ENC_KEY, bundle.refreshToken);
  await env.DB.prepare(
    `INSERT INTO oauth_account (
      id, x_user_id, x_username, display_name, subscription_type,
      access_token_enc, refresh_token_enc, iv_access, iv_refresh,
      expires_at, scopes, updated_at, needs_reconnect, lease_until, lease_id
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)
    ON CONFLICT(id) DO UPDATE SET
      x_user_id = excluded.x_user_id,
      x_username = excluded.x_username,
      display_name = excluded.display_name,
      subscription_type = excluded.subscription_type,
      access_token_enc = excluded.access_token_enc,
      refresh_token_enc = excluded.refresh_token_enc,
      iv_access = excluded.iv_access,
      iv_refresh = excluded.iv_refresh,
      expires_at = excluded.expires_at,
      scopes = excluded.scopes,
      updated_at = excluded.updated_at,
      needs_reconnect = 0,
      lease_until = NULL,
      lease_id = NULL`,
  )
    .bind(
      user.id,
      user.username,
      user.displayName,
      user.subscriptionType,
      access.cipher,
      refresh.cipher,
      access.iv,
      refresh.iv,
      now + bundle.expiresIn * 1000,
      bundle.scope,
      now,
    )
    .run();
  if (!switching && (await disconnectWindow(env)) !== null) {
    await markMissedDue(env, now);
  }
  await clearDisconnected(env);
}

export async function markReconnect(env: Env, now: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE oauth_account SET needs_reconnect = 1, lease_id = NULL, lease_until = NULL, updated_at = ? WHERE id = 1",
  )
    .bind(now)
    .run();
}

async function revokeStoredRefresh(env: Env, row: AccountRow): Promise<void> {
  if (!row.refresh_token_enc || !row.iv_refresh) return;
  try {
    const refresh = await decryptString(
      env.TOKEN_ENC_KEY,
      row.refresh_token_enc,
      row.iv_refresh,
    );
    await revokeToken(env, refresh);
  } catch {
    // The local row is still replaced when revoke does not complete.
  }
}

export async function disconnectAccount(env: Env): Promise<void> {
  const row = await readRow(env);
  if (row) await revokeStoredRefresh(env, row);
  const now = Date.now();
  await markMissedDue(env, now);
  await noteDisconnected(env, now);
  await env.DB.prepare("DELETE FROM oauth_account WHERE id = 1").run();
}

async function decryptAccess(
  env: Env,
  row: AccountRow,
): Promise<string | null> {
  if (!row.access_token_enc || !row.iv_access) return null;
  return decryptString(env.TOKEN_ENC_KEY, row.access_token_enc, row.iv_access);
}

function tokenIsFresh(row: AccountRow, now: number): boolean {
  const freshUntil = (row.expires_at ?? 0) - 10 * 60 * 1000;
  return now < freshUntil;
}

async function tokenAfterLostLease(
  env: Env,
  now: number,
): Promise<string | null> {
  const deadline = Date.now() + REFRESH_LEASE_MS;
  while (true) {
    const row = await readRow(env);
    if (!row?.access_token_enc || row.needs_reconnect === 1) return null;
    if (tokenIsFresh(row, now)) return decryptAccess(env, row);
    const leaseHeld =
      Boolean(row.lease_id) && (row.lease_until ?? 0) > Date.now();
    const remaining = deadline - Date.now();
    if (!leaseHeld || remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(200, remaining)),
    );
  }
  const row = await readRow(env);
  if (!row?.access_token_enc || row.needs_reconnect === 1) return null;
  if (tokenIsFresh(row, now)) return decryptAccess(env, row);
  return null;
}

async function rejectStoredToken(
  env: Env,
  row: AccountRow,
  now: number,
): Promise<void> {
  if (row.refresh_token_enc && row.iv_refresh) {
    try {
      const refresh = await decryptString(
        env.TOKEN_ENC_KEY,
        row.refresh_token_enc,
        row.iv_refresh,
      );
      await revokeToken(env, refresh);
    } catch {
      // The local row is marked for reconnect even when revoke does not complete.
    }
  }
  await markReconnect(env, now);
}

async function refreshUnderLease(
  env: Env,
  now: number,
  force: boolean,
  allowAccountSwitch: boolean,
): Promise<string | null> {
  const row = await readRow(env);
  if (
    !row?.access_token_enc ||
    !row.iv_access ||
    !row.refresh_token_enc ||
    !row.iv_refresh
  ) {
    return null;
  }
  if (row.needs_reconnect === 1) return null;
  if (!row.scopes || !scopesAreExact(row.scopes)) {
    await rejectStoredToken(env, row, now);
    return null;
  }
  const freshUntil = (row.expires_at ?? 0) - 10 * 60 * 1000;
  if (!force && now < freshUntil) return decryptAccess(env, row);
  const leaseId = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    "UPDATE oauth_account SET lease_id = ?, lease_until = ? WHERE id = 1 AND (lease_until IS NULL OR lease_until < ?)",
  )
    .bind(leaseId, now + REFRESH_LEASE_MS, now)
    .run();
  if (rowChanges(claimed) !== 1) return tokenAfterLostLease(env, now);
  try {
    const refresh = await decryptString(
      env.TOKEN_ENC_KEY,
      row.refresh_token_enc,
      row.iv_refresh,
    );
    const next = await refreshAccessToken(env, refresh);
    if (next.type !== "ok") {
      if (next.type === "rejected" && next.detail === "scope") {
        await markReconnect(env, now);
        return null;
      }
      await markReconnect(env, now);
      return null;
    }
    const me = await fetchMe(env, next.value.accessToken);
    if (me.type !== "ok") {
      await revokeToken(env, next.value.refreshToken);
      await markReconnect(env, now);
      return null;
    }
    // A 401 retry must not swap the account under an in-flight post.
    if (!allowAccountSwitch && row.x_user_id && me.value.id !== row.x_user_id) {
      await revokeToken(env, next.value.refreshToken);
      await markReconnect(env, now);
      return null;
    }
    await saveTokenBundle(
      env,
      next.value,
      {
        id: me.value.id,
        username: me.value.username,
        displayName: me.value.displayName,
        subscriptionType: me.value.subscriptionType,
      },
      now,
    );
    return next.value.accessToken;
  } catch {
    await env.DB.prepare(
      "UPDATE oauth_account SET lease_id = NULL, lease_until = NULL WHERE id = 1 AND lease_id = ?",
    )
      .bind(leaseId)
      .run();
    return tokenAfterLostLease(env, now);
  }
}

export async function accessTokenForPosting(
  env: Env,
  now: number,
): Promise<string | null> {
  return refreshUnderLease(env, now, false, true);
}

const AVATAR_KEY = "avatar/profile";

export async function cacheAvatar(
  env: Env,
  rawUrl: string | null,
): Promise<void> {
  if (!rawUrl) return;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  let apiOrigin = "";
  try {
    apiOrigin = new URL(env.X_API_BASE).origin;
  } catch {
    apiOrigin = "";
  }
  const apiHost = apiOrigin
    ? new URL(env.X_API_BASE).hostname.toLowerCase()
    : "";
  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === apiHost || host === "pbs.twimg.com" || host === "ton.twimg.com";
  if (!allowed || (host !== apiHost && isBlockedHost(host))) return;
  try {
    const timeout = Number(env.X_FETCH_TIMEOUT_MS);
    const response = await fetch(rawUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(
        Number.isFinite(timeout) && timeout > 0 ? timeout : 15000,
      ),
    });
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      return;
    }
    const mime = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (!mime || !isImageMime(mime)) {
      await response.body?.cancel();
      return;
    }
    const bytes = await readLimitedStream(response, 2 * 1024 * 1024);
    if (bytes.byteLength < 1) return;
    await env.MEDIA.put(AVATAR_KEY, bytes, {
      httpMetadata: { contentType: mime },
    });
    await env.DB.prepare(
      "UPDATE oauth_account SET avatar_r2_key = ? WHERE id = 1",
    )
      .bind(AVATAR_KEY)
      .run();
  } catch {
    return;
  }
}

export async function readAvatar(
  env: Env,
): Promise<{ body: ReadableStream; mime: string } | null> {
  const row = await env.DB.prepare(
    "SELECT avatar_r2_key FROM oauth_account WHERE id = 1",
  ).first<{ avatar_r2_key: string | null }>();
  if (!row?.avatar_r2_key) return null;
  const object = await env.MEDIA.get(row.avatar_r2_key);
  if (!object) return null;
  return {
    body: object.body,
    mime: object.httpMetadata?.contentType ?? "image/jpeg",
  };
}

export async function forceRefresh(
  env: Env,
  now: number,
): Promise<string | null> {
  return refreshUnderLease(env, now, true, false);
}
