import { rowChanges } from "../items/store";
import { ulid } from "../lib/ulid";

export type PostingGate = {
  allowed: boolean;
  paused: boolean;
};

type SettingsRow = {
  posting_paused: number;
  posting_blocked_since: number | null;
};

async function settings(env: Env): Promise<SettingsRow> {
  const row = await env.DB.prepare(
    "SELECT posting_paused, posting_blocked_since FROM app_settings WHERE id = 1",
  ).first<SettingsRow>();
  return row ?? { posting_paused: 0, posting_blocked_since: null };
}

export async function postingGate(env: Env): Promise<PostingGate> {
  const row = await settings(env);
  const paused = row.posting_paused === 1;
  return {
    paused,
    allowed: env.POSTING_ENABLED === "true" && !paused,
  };
}

// The app can set this. Nothing in the app clears it.
export async function pauseAllPosting(
  env: Env,
  actor: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE app_settings
     SET posting_paused = 1, paused_at = ?, paused_by = ?,
       posting_blocked_since = COALESCE(posting_blocked_since, ?)
     WHERE id = 1`,
  )
    .bind(now, actor, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO audit_log (id, item_id, actor, action, from_status, to_status, content_hash, at, detail_json)
     VALUES (?, NULL, ?, 'pause_posting', NULL, NULL, '', ?, NULL)`,
  )
    .bind(ulid(), actor, now)
    .run();
}

export async function notePostingBlocked(env: Env, now: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE app_settings SET posting_blocked_since = COALESCE(posting_blocked_since, ?) WHERE id = 1",
  )
    .bind(now)
    .run();
}

export async function postingBlockedSince(env: Env): Promise<number | null> {
  const row = await settings(env);
  return row.posting_blocked_since;
}

export async function clearPostingBlocked(env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE app_settings SET posting_blocked_since = NULL WHERE id = 1",
  ).run();
}

export async function noteDisconnected(env: Env, now: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE app_settings SET disconnected_since = COALESCE(disconnected_since, ?) WHERE id = 1",
  )
    .bind(now)
    .run();
}

export async function clearDisconnected(env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE app_settings SET disconnected_since = NULL WHERE id = 1",
  ).run();
}

export async function disconnectWindow(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT disconnected_since FROM app_settings WHERE id = 1",
  ).first<{ disconnected_since: number | null }>();
  return row?.disconnected_since ?? null;
}

// Marks rows the connected account no longer owns. It does not write the
// attempt, the status, the lease, the slot, or the post id. settle writes
// those, and an in-flight send is left alone until its own settle runs.
export async function clearUnpostedApprovals(
  env: Env,
  userId: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE items SET pending_resolution = 'account_switch', updated_at = ?
     WHERE approved_x_user_id IS NOT NULL
       AND approved_x_user_id != ?
       AND pending_resolution IS NULL
       AND status IN ('approved', 'scheduled', 'posting', 'needs_you', 'draft')`,
  )
    .bind(now, userId)
    .run();
}

// Due scheduled items that were not sent become missed. Status stays
// scheduled so approval is unchanged, and the dispatcher will not claim them.
export async function markMissedDue(env: Env, now: number): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT id, content_hash FROM items
     WHERE status = 'scheduled' AND missed = 0 AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
  )
    .bind(now)
    .all<{ id: string; content_hash: string }>();
  let marked = 0;
  for (const row of due.results ?? []) {
    const result = await env.DB.prepare(
      "UPDATE items SET missed = 1, updated_at = ? WHERE id = ? AND status = 'scheduled' AND missed = 0",
    )
      .bind(now, row.id)
      .run();
    if (rowChanges(result) !== 1) continue;
    marked += 1;
    await env.DB.prepare(
      `INSERT INTO audit_log (id, item_id, actor, action, from_status, to_status, content_hash, at, detail_json)
       VALUES (?, ?, 'dispatcher', 'missed', 'scheduled', 'scheduled', ?, ?, NULL)`,
    )
      .bind(ulid(), row.id, row.content_hash, now)
      .run();
  }
  return marked;
}
