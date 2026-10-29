import type { Kind, NeedsReason, ReviewStage, Status } from "../lib/state";

export type MediaRecord = {
  id: string;
  r2Key: string;
  mime: string;
  bytes: number;
  altText: string;
  xMediaId: string | null;
  xMediaExpiresAt: number | null;
};

export type SegmentRecord = {
  id: string;
  position: number;
  text: string;
  xPostId: string | null;
  postedAt: number | null;
  media: MediaRecord[];
};

export type ItemRecord = {
  id: string;
  kind: Kind;
  status: Status;
  reviewStage: ReviewStage;
  title: string | null;
  source: string;
  sourceRef: string | null;
  notes: string | null;
  reviewedBy: string | null;
  contentHash: string;
  approvedHash: string | null;
  approvedAt: number | null;
  approvedBy: string | null;
  scheduledAt: number | null;
  leaseUntil: number | null;
  leaseId: string | null;
  lastError: string | null;
  xArticleId: string | null;
  missed: boolean;
  needsReason: NeedsReason | null;
  resendSegmentId: string | null;
  createdAt: number;
  updatedAt: number;
  postedAt: number | null;
  segments: SegmentRecord[];
};

export type MediaInput = {
  altText: string;
  mime: string;
  bytes: Uint8Array;
  existingId?: string;
};

export type SegmentInput = {
  text: string;
  media: MediaInput[];
};

export type DraftInput = {
  kind: Kind;
  reviewStage?: ReviewStage;
  title: string | null;
  notes: string | null;
  reviewedBy: string | null;
  segments: SegmentInput[];
};

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AppError";
  }
}

export type ItemRow = {
  id: string;
  kind: Kind;
  status: Status;
  review_stage: ReviewStage;
  title: string | null;
  source: string;
  source_ref: string | null;
  notes: string | null;
  reviewed_by: string | null;
  content_hash: string;
  approved_hash: string | null;
  approved_at: number | null;
  approved_by: string | null;
  scheduled_at: number | null;
  lease_until: number | null;
  lease_id: string | null;
  last_error: string | null;
  x_article_id: string | null;
  missed: number;
  needs_reason: NeedsReason | null;
  resend_segment_id: string | null;
  created_at: number;
  updated_at: number;
  posted_at: number | null;
};

export type SegmentRow = {
  id: string;
  position: number;
  text: string;
  x_post_id: string | null;
  posted_at: number | null;
};

export type MediaRow = {
  id: string;
  segment_id: string | null;
  r2_key: string;
  mime: string;
  bytes: number;
  alt_text: string;
  x_media_id: string | null;
  x_media_expires_at: number | null;
};

export function mapItem(
  row: ItemRow,
  segments: SegmentRow[],
  media: MediaRow[],
): ItemRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    reviewStage: row.review_stage,
    title: row.title,
    source: row.source,
    sourceRef: row.source_ref,
    notes: row.notes,
    reviewedBy: row.reviewed_by,
    contentHash: row.content_hash,
    approvedHash: row.approved_hash,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    scheduledAt: row.scheduled_at,
    leaseUntil: row.lease_until,
    leaseId: row.lease_id,
    lastError: row.last_error,
    xArticleId: row.x_article_id,
    missed: row.missed === 1,
    needsReason: row.needs_reason,
    resendSegmentId: row.resend_segment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    postedAt: row.posted_at,
    segments: segments.map((segment) => ({
      id: segment.id,
      position: segment.position,
      text: segment.text,
      xPostId: segment.x_post_id,
      postedAt: segment.posted_at,
      media: media
        .filter((entry) => entry.segment_id === segment.id)
        .map((entry) => ({
          id: entry.id,
          r2Key: entry.r2_key,
          mime: entry.mime,
          bytes: entry.bytes,
          altText: entry.alt_text,
          xMediaId: entry.x_media_id,
          xMediaExpiresAt: entry.x_media_expires_at,
        })),
    })),
  };
}
