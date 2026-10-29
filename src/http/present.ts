import type { ItemRecord } from "../items/model";

export function presentItem(item: ItemRecord) {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    review_stage: item.reviewStage,
    title: item.title,
    source: item.source,
    source_ref: item.sourceRef,
    notes: item.notes,
    reviewed_by: item.reviewedBy,
    content_hash: item.contentHash,
    approved_hash: item.approvedHash,
    approved_at: item.approvedAt,
    approved_by: item.approvedBy,
    scheduled_at: item.scheduledAt,
    last_error: item.lastError,
    x_article_id: item.xArticleId,
    missed: item.missed,
    needs_reason: item.needsReason,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    posted_at: item.postedAt,
    segments: item.segments.map((segment) => ({
      position: segment.position,
      text: segment.text,
      x_post_id: segment.xPostId,
      posted_at: segment.postedAt,
      media: segment.media.map((media) => ({
        id: media.id,
        mime: media.mime,
        bytes: media.bytes,
        alt_text: media.altText,
      })),
    })),
  };
}
