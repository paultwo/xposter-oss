import { ulid } from "../lib/ulid";
import { AppError, type ItemRecord } from "./model";
import { getItem } from "./store";

// Statuses a person can delete. Posting, posted, and needs_you are left
// alone: those rows may already be on X, and deleting them here would not
// remove anything from X.
export const DELETABLE_STATUSES = [
  "draft",
  "approved",
  "scheduled",
  "archived",
] as const;

// A row that ever went to needs-you, or holds a lease, may be on X, so it
// keeps no Delete button even after it is archived.
export function canDelete(
  item: Pick<
    ItemRecord,
    | "status"
    | "postedAt"
    | "xArticleId"
    | "segments"
    | "leaseId"
    | "needsReason"
  >,
): boolean {
  if (!(DELETABLE_STATUSES as readonly string[]).includes(item.status)) {
    return false;
  }
  if (item.postedAt !== null || item.xArticleId !== null) return false;
  if (item.leaseId !== null || item.needsReason !== null) return false;
  return item.segments.every(
    (segment) => segment.xPostId === null && segment.postedAt === null,
  );
}

// Delete one item that never reached X. The guard runs in the same DELETE
// statement as the dispatcher's claim UPDATE runs in its own, so a scheduled
// post is either claimed first (and this refuses) or deleted first (and the
// claim finds no row). Segments, media rows, attempts, and the item's audit
// rows cascade. One audit row with no item id records the deletion.
export async function deleteItem(
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<{ id: string; status: ItemRecord["status"] }> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  if (!canDelete(item)) {
    throw new AppError(
      409,
      "This can't be deleted here. Anything that posted, or might have posted, stays.",
    );
  }
  const keys = await env.DB.prepare(
    "SELECT r2_key FROM media WHERE item_id = ? OR segment_id IN (SELECT id FROM segments WHERE item_id = ?)",
  )
    .bind(id, id)
    .all<{ r2_key: string }>();
  const guard = `items.id = ?
       AND items.status IN ('draft', 'approved', 'scheduled', 'archived')
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
           AND (post_attempts.outcome IS NULL OR post_attempts.outcome = 'posted')
       )`;
  // Rows the guard refuses for a lasting reason (an open or posted attempt,
  // a pending resolution) get the same answer as the status check above.
  const allowed = await env.DB.prepare(
    `SELECT 1 AS ok FROM items WHERE ${guard}`,
  )
    .bind(id, item.status)
    .first<{ ok: number }>();
  if (!allowed) {
    throw new AppError(
      409,
      "This can't be deleted here. Anything that posted, or might have posted, stays.",
    );
  }
  const [, , removed] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM daily_slots
       WHERE state = 'held'
         AND segment_id IN (SELECT id FROM segments WHERE item_id = ?)
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
      JSON.stringify({ item_id: id, kind: item.kind, source: item.source }),
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
  for (const row of keys.results ?? []) {
    await env.MEDIA.delete(row.r2_key);
  }
  return { id, status: item.status };
}
