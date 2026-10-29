import { contentHash } from "../lib/hash";
import { postLimits } from "../lib/plan";
import { nextStatus, type ReviewStage } from "../lib/state";
import { splitWeighted, TextSplitError } from "../lib/text";
import { ulid } from "../lib/ulid";
import {
  assertSegments,
  auditStatement,
  canon,
  clean,
  deleteOrphans,
  insertContent,
  materializeMedia,
  unchangedSince,
} from "./content";
import {
  AppError,
  type DraftInput,
  type ItemRecord,
  type SegmentInput,
} from "./model";
import { findBySource, getItem, rowChanges } from "./store";

export async function createDraft(
  env: Env,
  input: DraftInput & {
    source: string;
    sourceRef: string | null;
    actor: string;
    now: number;
    createdAt?: number;
  },
): Promise<{ item: ItemRecord; created: boolean }> {
  const notes = clean(input.notes, 5000);
  const reviewed = clean(input.reviewedBy, 200);
  const kind = assertSegments(
    input.kind,
    input.segments,
    postLimits(env).premium,
  );
  const title = kind === "article" ? clean(input.title, 200) : null;
  if (kind === "article" && !title)
    throw new AppError(422, "An Article needs a title.");
  if (input.sourceRef) {
    const existing = await findBySource(env, input.source, input.sourceRef);
    if (existing) return { item: existing, created: false };
  }
  const id = ulid(input.now);
  const media = await materializeMedia(env, null, input.segments);
  const hash = await contentHash(canon(kind, title, input.segments, media));
  const createdAt = input.createdAt ?? input.now;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO items (
          id, kind, status, review_stage, title, source, source_ref, notes, reviewed_by, content_hash,
          approved_hash, approved_at, approved_by, scheduled_at, lease_until, lease_id,
          last_error, x_article_id, created_at, updated_at, posted_at
        ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
      ).bind(
        id,
        kind,
        input.reviewStage ?? "draft",
        title,
        input.source,
        input.sourceRef,
        notes,
        reviewed,
        hash,
        createdAt,
        input.now,
      ),
      ...insertContent(env, id, input.segments, media),
      auditStatement(
        env,
        id,
        input.actor,
        "create",
        null,
        "draft",
        hash,
        input.now,
      ),
    ]);
  } catch {
    if (input.sourceRef) {
      const existing = await findBySource(env, input.source, input.sourceRef);
      if (existing) return { item: existing, created: false };
    }
    throw new AppError(500, "The draft could not be saved.");
  }
  const saved = await getItem(env, id);
  if (!saved) throw new AppError(500, "The draft could not be saved.");
  return { item: saved, created: true };
}

export async function updateDraft(
  env: Env,
  id: string,
  input: DraftInput,
  actor: string,
  now: number,
): Promise<ItemRecord> {
  const current = await getItem(env, id);
  if (!current) throw new AppError(404, "That draft is not here.");
  const openAttempt = await env.DB.prepare(
    "SELECT id FROM post_attempts WHERE item_id = ? AND outcome IS NULL LIMIT 1",
  )
    .bind(id)
    .first();
  if (openAttempt) {
    throw new AppError(
      409,
      "Check X before changing this. A post attempt is still unresolved.",
    );
  }
  if (current.segments.some((segment) => segment.xPostId)) {
    throw new AppError(
      409,
      "Part of this is already on X, so the text stays locked.",
    );
  }
  const notes = clean(input.notes, 5000);
  const reviewed = clean(input.reviewedBy, 200);
  const kind = assertSegments(
    input.kind,
    input.segments,
    postLimits(env).premium,
  );
  const title = kind === "article" ? clean(input.title, 200) : null;
  if (kind === "article" && !title)
    throw new AppError(422, "An Article needs a title.");
  const media = await materializeMedia(env, id, input.segments);
  const hash = await contentHash(canon(kind, title, input.segments, media));
  const hashChanged = hash !== current.contentHash;
  const status = nextStatus(current.status, { type: "edit", hashChanged });
  if (!status) throw new AppError(409, "This item can no longer be edited.");
  const clearApproval =
    status === "draft" && (hashChanged || current.status === "needs_you");
  const stage: ReviewStage =
    input.reviewStage ?? (hashChanged ? "draft" : current.reviewStage);
  const guard = unchangedSince(current);
  const results = await env.DB.batch([
    ...insertContent(env, id, input.segments, media, guard),
    env.DB.prepare(
      `INSERT INTO audit_log (id, item_id, actor, action, from_status, to_status, content_hash, at, detail_json)
       SELECT ?, ?, ?, 'edit', ?, ?, ?, ?, NULL WHERE ${guard.sql}`,
    ).bind(
      ulid(),
      id,
      actor,
      current.status,
      status,
      hash,
      now,
      ...guard.binds,
    ),
    env.DB.prepare(
      `UPDATE items SET kind = ?, status = ?, review_stage = ?, title = ?, notes = ?, reviewed_by = ?, content_hash = ?,
        approved_hash = ?, approved_at = ?, approved_by = ?, scheduled_at = ?, last_error = NULL,
        x_article_id = ?, approved_x_user_id = CASE WHEN ? = 'draft' THEN NULL ELSE approved_x_user_id END,
        missed = CASE WHEN ? = 'draft' THEN 0 ELSE missed END,
        needs_reason = CASE WHEN ? = 'draft' THEN NULL ELSE needs_reason END,
        resend_segment_id = CASE WHEN ? = 'draft' THEN NULL ELSE resend_segment_id END,
        updated_at = ?
       WHERE id = ? AND status = ? AND updated_at = ? AND lease_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM post_attempts
           WHERE post_attempts.item_id = ? AND post_attempts.outcome IS NULL
         )`,
    ).bind(
      kind,
      status,
      stage,
      title,
      notes,
      reviewed,
      hash,
      clearApproval ? null : current.approvedHash,
      clearApproval ? null : current.approvedAt,
      clearApproval ? null : current.approvedBy,
      status === "draft" ? null : current.scheduledAt,
      hashChanged ? null : current.xArticleId,
      status,
      status,
      status,
      status,
      now,
      id,
      current.status,
      current.updatedAt,
      id,
    ),
  ]);
  const itemUpdate = results[results.length - 1];
  if (!itemUpdate || rowChanges(itemUpdate) !== 1) {
    const kept = new Set(
      current.segments.flatMap((segment) =>
        segment.media.map((entry) => entry.r2Key),
      ),
    );
    for (const entry of media) {
      if (!kept.has(entry.r2Key)) await env.MEDIA.delete(entry.r2Key);
    }
    throw new AppError(
      409,
      "This changed while you were editing, or it started posting. Reload it before you edit again.",
    );
  }
  await deleteOrphans(env, current, new Set(media.map((entry) => entry.r2Key)));
  const saved = await getItem(env, id);
  if (!saved) throw new AppError(500, "The draft could not be saved.");
  return saved;
}

export async function splitItem(
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<ItemRecord> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  const segments: SegmentInput[] = [];
  for (const segment of item.segments) {
    let pieces: string[];
    try {
      pieces = splitWeighted(segment.text, postLimits(env).standard);
    } catch (error) {
      if (error instanceof TextSplitError)
        throw new AppError(422, error.message);
      throw error;
    }
    if (pieces.length === 0) continue;
    pieces.forEach((text, index) => {
      segments.push({
        text,
        media:
          index === 0
            ? segment.media.map((media) => ({
                altText: media.altText,
                mime: media.mime,
                bytes: new Uint8Array(),
                existingId: media.id,
              }))
            : [],
      });
    });
  }
  return updateDraft(
    env,
    id,
    {
      kind: "thread",
      title: item.title,
      notes: item.notes,
      reviewedBy: item.reviewedBy,
      segments,
    },
    actor,
    now,
  );
}

export async function makeArticle(
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<ItemRecord> {
  const item = await getItem(env, id);
  if (!item) throw new AppError(404, "That draft is not here.");
  if (item.segments.some((segment) => segment.media.length > 0)) {
    throw new AppError(422, "Remove the image first, or keep this as a post.");
  }
  const full = item.segments.map((segment) => segment.text).join("\n\n");
  const lines = full.split("\n");
  const first = lines.find((line) => line.trim())?.trim() ?? "Untitled";
  const title = item.title ?? first.slice(0, 200);
  const body = item.title ? full : lines.slice(1).join("\n").trim() || full;
  return updateDraft(
    env,
    id,
    {
      kind: "article",
      title,
      notes: item.notes,
      reviewedBy: item.reviewedBy,
      segments: [{ text: body, media: [] }],
    },
    actor,
    now,
  );
}
