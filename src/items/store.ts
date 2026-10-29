import {
  type ItemRecord,
  type ItemRow,
  type MediaRow,
  mapItem,
  type SegmentRow,
} from "./model";

export async function getItem(
  env: Env,
  id: string,
): Promise<ItemRecord | null> {
  const item = await env.DB.prepare("SELECT * FROM items WHERE id = ?")
    .bind(id)
    .first<ItemRow>();
  if (!item) return null;
  const segments = await env.DB.prepare(
    "SELECT id, position, text, x_post_id, posted_at FROM segments WHERE item_id = ? ORDER BY position",
  )
    .bind(id)
    .all<SegmentRow>();
  const media = await env.DB.prepare(
    "SELECT id, segment_id, r2_key, mime, bytes, alt_text, x_media_id, x_media_expires_at FROM media WHERE item_id = ? ORDER BY position, id",
  )
    .bind(id)
    .all<MediaRow>();
  return mapItem(item, segments.results ?? [], media.results ?? []);
}

export async function listItems(
  env: Env,
  statuses: string[],
): Promise<ItemRecord[]> {
  const marks = statuses.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT id FROM items WHERE status IN (${marks}) ORDER BY COALESCE(scheduled_at, updated_at) DESC LIMIT 100`,
  )
    .bind(...statuses)
    .all<{ id: string }>();
  const items: ItemRecord[] = [];
  for (const row of rows.results ?? []) {
    const item = await getItem(env, row.id);
    if (item) items.push(item);
  }
  return items;
}

export async function findBySource(
  env: Env,
  source: string,
  sourceRef: string,
): Promise<ItemRecord | null> {
  const row = await env.DB.prepare(
    "SELECT id FROM items WHERE source = ? AND source_ref = ?",
  )
    .bind(source, sourceRef)
    .first<{ id: string }>();
  if (!row) return null;
  return getItem(env, row.id);
}

export async function creditsEmpty(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM items WHERE last_error = ? AND status = 'needs_you' AND needs_reason = 'rejected' LIMIT 1",
  )
    .bind("X API credits are empty.")
    .first();
  return row !== null;
}

export function rowChanges(result: D1Result): number {
  return result.meta.changes ?? 0;
}
