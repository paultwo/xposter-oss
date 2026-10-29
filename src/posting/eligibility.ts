// A segment may be sent only when no attempt is still unresolved and the
// segment is not already on X. Claim and draft saves both use this. A
// dashboard link is not enough.

export function maySendSegmentSql(): string {
  return `NOT EXISTS (
         SELECT 1 FROM post_attempts
         WHERE post_attempts.segment_id = ? AND post_attempts.outcome IS NULL
       )
       AND EXISTS (
         SELECT 1 FROM segments
         WHERE segments.id = ?
           AND segments.item_id = items.id
           AND segments.x_post_id IS NULL
       )`;
}

export function noOpenAttemptSql(): string {
  return `NOT EXISTS (
    SELECT 1 FROM post_attempts
    WHERE post_attempts.item_id = ? AND post_attempts.outcome IS NULL
  )`;
}
