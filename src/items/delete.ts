import { log } from "../lib/log";
import { ulid } from "../lib/ulid";
import { xFetchTimeoutMs } from "../x/client";
import { AppError, type ItemRecord } from "./model";
import { getItem } from "./store";

// Statuses a person can delete. Posting and posted are left alone: deleting
// them here would not remove anything from X, and the app would lose the
// record of what is there.
export const DELETABLE_STATUSES = [
  "draft",
  "approved",
  "scheduled",
  "needs_you",
  "archived",
] as const;

const REFUSED =
  "This can't be deleted here. Anything that is posting, or has any part on X, stays.";

// A row that holds a lease is mid-send, and a row with any post id is at
// least partly on X, so neither gets a Delete button.
export function canDelete(
  item: Pick<
    ItemRecord,
    "status" | "postedAt" | "xArticleId" | "segments" | "leaseId"
  >,
): boolean {
  if (!(DELETABLE_STATUSES as readonly string[]).includes(item.status)) {
    return false;
  }
  if (item.postedAt !== null || item.xArticleId !== null) return false;
  if (item.leaseId !== null) return false;
  return item.segments.every(
    (segment) => segment.xPostId === null && segment.postedAt === null,
  );
}

// Delete one item with no part on X. The guard runs in the same DELETE
// statement as the dispatcher's claim UPDATE and the Send again UPDATE run
// in theirs, so a scheduled or needs-you item is either claimed or resumed
// first (and this refuses) or deleted first (and the other finds no row).
// Segments, media rows, attempts, and the item's audit rows cascade, and the
// held daily slots are released, so nothing is left for the cron to pick up.
// One audit row with no item id records the deletion.
export async function deleteItem(
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<{ id: string; status: ItemRecord["status"] }> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  if (!canDelete(item)) throw new AppError(409, REFUSED);
  // Same wait as Send again: a swept attempt may still be talking to X.
  if (
    item.needsReason === "unknown" &&
    item.leaseUntil !== null &&
    now < item.leaseUntil + xFetchTimeoutMs(env)
  ) {
    throw new AppError(
      409,
      "Wait until the last attempt has finished, then check X.",
    );
  }
  const keys = await env.DB.prepare(
    "SELECT r2_key FROM media WHERE item_id = ? OR segment_id IN (SELECT id FROM segments WHERE item_id = ?)",
  )
    .bind(id, id)
    .all<{ r2_key: string }>();
  const guard = `items.id = ?
       AND items.status IN ('draft', 'approved', 'scheduled', 'needs_you', 'archived')
       AND items.status = ?
       AND items.lease_id IS NULL
       AND items.posted_at IS NULL
       AND items.x_article_id IS NULL
       AND items.pending_resolution IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM segments
         WHERE segments.item_id = items.id
           AND (segments.x_post_id IS NOT NULL OR segments.posted_at IS NOT NULL)
       )
       AND NOT EXISTS (
         SELECT 1 FROM post_attempts
         WHERE post_attempts.item_id = items.id
           AND (
             post_attempts.outcome = 'posted'
             OR (
               post_attempts.outcome IS NULL
               AND items.status NOT IN ('needs_you', 'archived')
             )
           )
       )`;
  // An unresolved attempt on a needs-you or archived row with no lease is an
  // unconfirmed send. It may be on X, and the dialog says so before delete.
  // Rows the guard refuses for a lasting reason (a posted attempt, a pending
  // resolution) get the same answer as the check above.
  const allowed = await env.DB.prepare(
    `SELECT 1 AS ok FROM items WHERE ${guard}`,
  )
    .bind(id, item.status)
    .first<{ ok: number }>();
  if (!allowed) throw new AppError(409, REFUSED);
  const [, , removed] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM daily_slots
       WHERE segment_id IN (SELECT id FROM segments WHERE item_id = ?)
         AND EXISTS (SELECT 1 FROM items WHERE ${guard})`,
    ).bind(id, id, item.status),
    env.DB.prepare(
      `INSERT INTO audit_log (id, item_id, actor, action, from_status, to_status, content_hash, at, detail_json)
       SELECT ?, NULL, ?, 'delete', ?, NULL, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM items WHERE ${guard})`,
    ).bind(
      ulid(now),
      actor,
      item.status,
      item.contentHash,
      now,
      JSON.stringify({
        item_id: id,
        kind: item.kind,
        source: item.source,
        needs_reason: item.needsReason,
      }),
      id,
      item.status,
    ),
    env.DB.prepare(`DELETE FROM items WHERE ${guard} RETURNING id`).bind(
      id,
      item.status,
    ),
  ]);
  // meta.changes can include cascaded rows, so count what DELETE returned.
  if ((removed?.results ?? []).length !== 1) {
    throw new AppError(
      409,
      "This changed while you were deleting it. Nothing was deleted.",
    );
  }
  // The rows are already gone, so a failed blob delete only leaves an
  // unreferenced object in R2. The key is not logged.
  for (const row of keys.results ?? []) {
    try {
      await env.MEDIA.delete(row.r2_key);
    } catch (error) {
      log("error", "media_delete_failed", {
        item_id: id,
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return { id, status: item.status };
}
