import type { CanonMedia } from "../lib/hash";
import type { Kind, Status } from "../lib/state";
import { ulid } from "../lib/ulid";
import { noOpenAttemptSql } from "../posting/eligibility";
import { assertMediaSet } from "./media";
import {
  AppError,
  type ItemRecord,
  type MediaInput,
  type SegmentInput,
} from "./model";

export function overLimitNote(standard: number): string {
  return `Over ${standard}: choose long post, thread, or Article`;
}

type StoredMedia = {
  id: string;
  segmentPosition: number;
  ordinal: number;
  r2Key: string;
  mime: string;
  bytes: number;
  altText: string;
  xMediaId: string | null;
  xMediaExpiresAt: number | null;
};

export function clean(
  value: string | null | undefined,
  max: number,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max)
    throw new AppError(422, `Keep this under ${max} characters.`);
  return trimmed;
}

export function assertSegments(
  kind: Kind,
  segments: SegmentInput[],
  maxChars: number,
): Kind {
  if (segments.length < 1 || segments.length > 25) {
    throw new AppError(422, "Use between 1 and 25 segments.");
  }
  let resolved: Kind = kind;
  if (resolved === "post" && segments.length > 1) resolved = "thread";
  if (resolved === "article" && segments.length !== 1) {
    throw new AppError(422, "An Article has one body.");
  }
  if (
    resolved === "article" &&
    segments.some((segment) => segment.media.length > 0)
  ) {
    throw new AppError(
      422,
      "Articles post text only for now. Remove the image, or keep this as a post.",
    );
  }
  for (const [index, segment] of segments.entries()) {
    if (segment.text.length > maxChars) {
      throw new AppError(
        422,
        `A segment is over ${maxChars.toLocaleString("en-US")} characters.`,
      );
    }
    if (!segment.text.trim() && segment.media.length === 0) {
      throw new AppError(422, `Segment ${index + 1} is empty.`);
    }
    assertMediaSet(segment.media, index);
  }
  return resolved;
}

export async function materializeMedia(
  env: Env,
  itemId: string | null,
  segments: SegmentInput[],
): Promise<StoredMedia[]> {
  const stored: StoredMedia[] = [];
  for (const [position, segment] of segments.entries()) {
    for (const [ordinal, media] of segment.media.entries()) {
      stored.push(await oneMedia(env, itemId, position, ordinal, media));
    }
  }
  return stored;
}

async function oneMedia(
  env: Env,
  itemId: string | null,
  position: number,
  ordinal: number,
  media: MediaInput,
): Promise<StoredMedia> {
  if (media.existingId) {
    if (!itemId)
      throw new AppError(422, "That image is not attached to this draft.");
    const row = await env.DB.prepare(
      "SELECT id, r2_key, mime, bytes, alt_text, x_media_id, x_media_expires_at FROM media WHERE id = ? AND item_id = ?",
    )
      .bind(media.existingId, itemId)
      .first<{
        id: string;
        r2_key: string;
        mime: string;
        bytes: number;
        alt_text: string;
        x_media_id: string | null;
        x_media_expires_at: number | null;
      }>();
    if (!row)
      throw new AppError(422, "That image is not attached to this draft.");
    const altChanged = row.alt_text !== media.altText;
    return {
      id: row.id,
      segmentPosition: position,
      ordinal,
      r2Key: row.r2_key,
      mime: row.mime,
      bytes: row.bytes,
      altText: media.altText,
      xMediaId: altChanged ? null : row.x_media_id,
      xMediaExpiresAt: altChanged ? null : row.x_media_expires_at,
    };
  }
  const id = ulid();
  const r2Key = `media/${id}`;
  await env.MEDIA.put(r2Key, media.bytes, {
    httpMetadata: { contentType: media.mime },
  });
  return {
    id,
    segmentPosition: position,
    ordinal,
    r2Key,
    mime: media.mime,
    bytes: media.bytes.byteLength,
    altText: media.altText,
    xMediaId: null,
    xMediaExpiresAt: null,
  };
}

export function canon(
  kind: Kind,
  title: string | null,
  segments: SegmentInput[],
  media: StoredMedia[],
) {
  return {
    kind,
    title,
    segments: segments.map((segment, position) => ({
      position,
      text: segment.text,
      media: media
        .filter((entry) => entry.segmentPosition === position)
        .map(
          (entry): CanonMedia => ({
            altText: entry.altText,
            mime: entry.mime,
            r2Key: entry.r2Key,
          }),
        ),
    })),
  };
}

type Guard = { sql: string; binds: unknown[] };

const NO_GUARD: Guard = { sql: "1", binds: [] };

// Every statement in an edit checks the row it read, so a cron claim that
// lands between the read and the batch leaves the content untouched.
export function unchangedSince(item: ItemRecord): Guard {
  return {
    sql: `EXISTS (SELECT 1 FROM items WHERE id = ? AND status = ? AND updated_at = ? AND lease_id IS NULL) AND ${noOpenAttemptSql()}`,
    binds: [item.id, item.status, item.updatedAt, item.id],
  };
}

export function insertContent(
  env: Env,
  itemId: string,
  segments: SegmentInput[],
  media: StoredMedia[],
  guard: Guard = NO_GUARD,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM media WHERE item_id = ? AND ${guard.sql}`).bind(
      itemId,
      ...guard.binds,
    ),
    env.DB.prepare(
      `DELETE FROM segments WHERE item_id = ? AND ${guard.sql}`,
    ).bind(itemId, ...guard.binds),
  ];
  const segmentIds = new Map<number, string>();
  for (const [position, segment] of segments.entries()) {
    const id = ulid();
    segmentIds.set(position, id);
    statements.push(
      env.DB.prepare(
        `INSERT INTO segments (id, item_id, position, text, x_post_id, posted_at)
         SELECT ?, ?, ?, ?, NULL, NULL WHERE ${guard.sql}`,
      ).bind(id, itemId, position, segment.text, ...guard.binds),
    );
  }
  for (const entry of media) {
    const segmentId = segmentIds.get(entry.segmentPosition);
    statements.push(
      env.DB.prepare(
        `INSERT INTO media (
          id, item_id, segment_id, position, r2_key, mime, bytes, alt_text, x_media_id, x_media_expires_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
      ).bind(
        entry.id,
        itemId,
        segmentId,
        entry.ordinal,
        entry.r2Key,
        entry.mime,
        entry.bytes,
        entry.altText,
        entry.xMediaId,
        entry.xMediaExpiresAt,
        ...guard.binds,
      ),
    );
  }
  return statements;
}

export function auditStatement(
  env: Env,
  itemId: string,
  actor: string,
  action: string,
  from: Status | null,
  to: Status,
  hash: string,
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_log (id, item_id, actor, action, from_status, to_status, content_hash, at, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(ulid(), itemId, actor, action, from, to, hash, now);
}

export async function deleteOrphans(
  env: Env,
  previous: ItemRecord | null,
  nextKeys: Set<string>,
): Promise<void> {
  if (!previous) return;
  for (const segment of previous.segments) {
    for (const media of segment.media) {
      if (!nextKeys.has(media.r2Key)) await env.MEDIA.delete(media.r2Key);
    }
  }
}
