import { base64ToBytes, decodedBase64Length } from "../lib/bytes";
import {
  type IntakeStage,
  isIntakeStage,
  isKind,
  type Kind,
} from "../lib/state";
import { auditStatement } from "./content";
import { createDraft, updateDraft } from "./drafts";
import { isImageMime, sniffImage } from "./media";
import {
  AppError,
  type DraftInput,
  type ItemRecord,
  type MediaInput,
  type SegmentInput,
} from "./model";
import { findBySource, getItem, rowChanges } from "./store";

export function parseKind(value: unknown): Kind {
  if (typeof value !== "string" || !isKind(value))
    throw new AppError(422, "Kind must be post, thread, or article.");
  return value;
}

export async function draftsFromIntake(
  env: Env,
  source: string,
  body: unknown,
  actor: string,
  now: number,
): Promise<{ item: ItemRecord; created: boolean }> {
  const parsed = parseLooseDraft(body);
  if (parsed.sourceRef) {
    const existing = await findBySource(env, source, parsed.sourceRef);
    if (existing) return { item: existing, created: false };
  }
  const segments = await resolveIntakeMedia(parsed.segments);
  const saved = await createDraft(env, {
    ...parsed,
    segments,
    source,
    sourceRef: parsed.sourceRef,
    actor,
    now,
  });
  return saved;
}

const IMAGE_CAP = 5 * 1024 * 1024;

async function resolveIntakeMedia(
  segments: Array<{
    text: string;
    media: MediaInput[];
  }>,
): Promise<SegmentInput[]> {
  return segments.map((segment) => ({
    text: segment.text,
    media: segment.media,
  }));
}

function parseStage(value: unknown): IntakeStage | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isIntakeStage(value)) {
    throw new AppError(422, "Stage must be needs_hemingway or needs_approval.");
  }
  return value;
}

function parseLooseDraft(body: unknown): {
  kind: DraftInput["kind"];
  reviewStage: IntakeStage | undefined;
  title: string | null;
  notes: string | null;
  reviewedBy: string | null;
  sourceRef: string | null;
  segments: Array<{
    text: string;
    media: MediaInput[];
  }>;
} {
  if (!body || typeof body !== "object")
    throw new AppError(400, "Send a JSON object.");
  const record = body as Record<string, unknown>;
  const kind = parseKind(record.kind);
  const reviewStage = parseStage(record.stage);
  const title = typeof record.title === "string" ? record.title : null;
  const notes = typeof record.notes === "string" ? record.notes : null;
  const reviewed = Array.isArray(record.reviewed_by)
    ? record.reviewed_by
        .filter((entry): entry is string => typeof entry === "string")
        .join(", ")
    : null;
  const sourceRef =
    typeof record.source_ref === "string" && record.source_ref.trim()
      ? record.source_ref.trim()
      : null;
  if (!Array.isArray(record.segments) || record.segments.length === 0) {
    throw new AppError(422, "Add at least one segment.");
  }
  const segments: Array<{
    text: string;
    media: MediaInput[];
  }> = [];
  for (const entry of record.segments) {
    if (!entry || typeof entry !== "object")
      throw new AppError(422, "A segment is missing.");
    const segment = entry as Record<string, unknown>;
    if (typeof segment.text !== "string")
      throw new AppError(422, "Each segment needs text.");
    const media: MediaInput[] = [];
    if (Array.isArray(segment.media)) {
      for (const raw of segment.media) {
        if (!raw || typeof raw !== "object")
          throw new AppError(422, "An image is missing.");
        const image = raw as Record<string, unknown>;
        if (typeof image.alt_text !== "string" || !image.alt_text.trim()) {
          throw new AppError(422, "Alt text is required.");
        }
        if (typeof image.url === "string") {
          throw new AppError(
            422,
            "Send the image bytes. Remote image URLs are not accepted.",
          );
        }
        if (
          typeof image.data_base64 !== "string" ||
          typeof image.mime !== "string"
        ) {
          throw new AppError(422, "An image needs mime and data_base64.");
        }
        if (decodedBase64Length(image.data_base64) > IMAGE_CAP) {
          throw new AppError(422, "Each image must be 5 MB or smaller.");
        }
        if (!isImageMime(image.mime)) {
          throw new AppError(422, "Images must be PNG, JPEG, GIF, or WebP.");
        }
        const bytes = base64ToBytes(image.data_base64);
        if (!sniffImage(bytes, image.mime)) {
          throw new AppError(422, "Images must be PNG, JPEG, GIF, or WebP.");
        }
        media.push({ altText: image.alt_text, mime: image.mime, bytes });
      }
    }
    segments.push({ text: segment.text, media });
  }
  return {
    kind,
    reviewStage,
    title,
    notes,
    reviewedBy: reviewed,
    sourceRef,
    segments,
  };
}

export async function patchIntakeDraft(
  env: Env,
  source: string,
  id: string,
  body: unknown,
  actor: string,
  now: number,
): Promise<ItemRecord> {
  const current = await getItem(env, id);
  if (!current || current.source !== source)
    throw new AppError(404, "That draft is not here.");
  if (current.status !== "draft")
    throw new AppError(403, "Intake can only change its own drafts.");
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!("segments" in record)) {
    const stage = parseStage(record.stage);
    if (!stage) throw new AppError(422, "Send segments or a stage.");
    return setReviewStage(env, current, stage, actor, now);
  }
  const parsed = parseLooseDraft(body);
  const segments = await resolveIntakeMedia(parsed.segments);
  return updateDraft(env, id, { ...parsed, segments }, actor, now);
}

async function setReviewStage(
  env: Env,
  item: ItemRecord,
  stage: IntakeStage,
  actor: string,
  now: number,
): Promise<ItemRecord> {
  const result = await env.DB.prepare(
    "UPDATE items SET review_stage = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
  )
    .bind(stage, now, item.id)
    .run();
  if (rowChanges(result) !== 1)
    throw new AppError(403, "Intake can only change its own drafts.");
  await auditStatement(
    env,
    item.id,
    actor,
    `stage_${stage}`,
    "draft",
    "draft",
    item.contentHash,
    now,
  ).run();
  const saved = await getItem(env, item.id);
  if (!saved) throw new AppError(500, "The draft could not be updated.");
  return saved;
}
