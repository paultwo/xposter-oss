import { rowChanges } from "../items/store";
import { ulid } from "../lib/ulid";

// The allowance is the last 24 hours, not the calendar day of the current
// time zone. A zone change must not open a new bucket, and posted_day is
// only a record of the local day at send time. It is never rewritten.
const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function postsInWindow(env: Env, now: number): Promise<number> {
  const since = now - WINDOW_MS;
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM segments WHERE posted_at IS NOT NULL AND posted_at >= ?)
       + (SELECT COUNT(*) FROM daily_slots WHERE state = 'held' AND created_at >= ?)
       AS n`,
  )
    .bind(since, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function releaseExpiredHolds(
  env: Env,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM daily_slots WHERE state = 'held' AND created_at < ?",
  )
    .bind(now - WINDOW_MS)
    .run();
}

export async function reserveSlot(
  env: Env,
  segmentId: string,
  day: string,
  cap: number,
  now: number,
): Promise<boolean> {
  const since = now - WINDOW_MS;
  await releaseExpiredHolds(env, now);
  try {
    const result = await env.DB.prepare(
      `INSERT INTO daily_slots (id, day_key, segment_id, state, created_at)
       SELECT ?, ?, ?, 'held', ?
       WHERE (
         (SELECT COUNT(*) FROM segments WHERE posted_at IS NOT NULL AND posted_at >= ?)
         + (SELECT COUNT(*) FROM daily_slots WHERE state = 'held' AND created_at >= ?)
       ) < ?
         AND NOT EXISTS (
           SELECT 1 FROM daily_slots
           WHERE segment_id = ? AND state = 'held' AND created_at >= ?
         )`,
    )
      .bind(ulid(now), day, segmentId, now, since, since, cap, segmentId, since)
      .run();
    return rowChanges(result) === 1;
  } catch {
    return false;
  }
}

export async function releaseSlot(env: Env, segmentId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM daily_slots WHERE segment_id = ?")
    .bind(segmentId)
    .run();
}

// Commits the one held row for this segment. The unique key means there is
// at most one, so the day is that row's day_key.
export async function recordPostedDay(
  env: Env,
  segmentId: string,
  fallbackDay: string,
): Promise<void> {
  const slot = await env.DB.prepare(
    "SELECT day_key FROM daily_slots WHERE segment_id = ?",
  )
    .bind(segmentId)
    .first<{ day_key: string }>();
  const day = slot?.day_key ?? fallbackDay;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE segments SET posted_day = COALESCE(posted_day, ?) WHERE id = ?",
    ).bind(day, segmentId),
    env.DB.prepare("DELETE FROM daily_slots WHERE segment_id = ?").bind(
      segmentId,
    ),
  ]);
}
