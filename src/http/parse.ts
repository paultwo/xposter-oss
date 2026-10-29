import { isImageMime } from "../items/media";
import {
  AppError,
  type DraftInput,
  type MediaInput,
  type SegmentInput,
} from "../items/model";
import { parseKind } from "../items/service";
import { base64ToBytes, decodedBase64Length } from "../lib/bytes";
import { etToUtc } from "../lib/time";
import type { FormMap } from "./types";

function textField(form: FormMap, key: string): string {
  const value = form[key];
  return typeof value === "string" ? value : "";
}

export function segmentIndexes(form: FormMap): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < 25; index++) {
    if (`text_${index}` in form) indexes.push(index);
  }
  return indexes.length > 0 ? indexes : [0];
}

export async function draftFromForm(form: FormMap): Promise<DraftInput> {
  const kind = parseKind(typeof form.kind === "string" ? form.kind : "");
  const segments: SegmentInput[] = [];
  let skipped = false;
  for (const index of segmentIndexes(form)) {
    const text = textField(form, `text_${index}`);
    const media = await mediaFromForm(form, index);
    if (!text.trim() && media.length === 0) {
      skipped = true;
      continue;
    }
    if (skipped)
      throw new AppError(422, "Fill each segment before adding the next.", {
        [`text_${index}`]: "This segment is empty.",
      });
    segments.push({ text, media });
  }
  if (segments.length === 0) {
    throw new AppError(422, "Write the post before saving.", {
      text_0: "Write the post.",
    });
  }
  return {
    kind,
    title: textField(form, "title") || null,
    notes: textField(form, "notes") || null,
    reviewedBy: null,
    segments,
  };
}

async function mediaFromForm(
  form: FormMap,
  segmentIndex: number,
): Promise<MediaInput[]> {
  const media: MediaInput[] = [];
  for (let image = 0; image < 4; image++) {
    const file = form[`file_${segmentIndex}_${image}`];
    const alt = textField(form, `alt_${segmentIndex}_${image}`);
    const existing = textField(form, `media_${segmentIndex}_${image}`);
    if (file instanceof File && file.size > 0) {
      if (file.size > 5 * 1024 * 1024)
        throw new AppError(422, "Each image must be 5 MB or smaller.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = (file.type || "").toLowerCase();
      if (!isImageMime(mime))
        throw new AppError(422, "Images must be PNG, JPEG, GIF, or WebP.");
      media.push({ altText: alt, mime, bytes });
      continue;
    }
    if (existing) {
      media.push({
        altText: alt,
        mime: "image/png",
        bytes: new Uint8Array(),
        existingId: existing,
      });
    }
  }
  return media;
}

export function scheduleFromForm(form: FormMap, timeZone: string): number {
  const date = textField(form, "date");
  const time = textField(form, "time");
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeParts = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateParts || !timeParts)
    throw new AppError(422, "Pick a date and time.");
  const utc = etToUtc(
    Number(dateParts[1]),
    Number(dateParts[2]),
    Number(dateParts[3]),
    Number(timeParts[1]),
    Number(timeParts[2]),
    timeZone,
  );
  if (utc === null)
    throw new AppError(422, "That time does not exist in this time zone.");
  return utc;
}

export function markPostedFromForm(
  form: FormMap,
): Array<{ position: number; xPostId: string }> {
  const posts: Array<{ position: number; xPostId: string }> = [];
  for (const [key, value] of Object.entries(form)) {
    const match = /^post_id_(\d+)$/.exec(key);
    if (!match?.[1] || typeof value !== "string" || !value.trim()) continue;
    posts.push({ position: Number(match[1]), xPostId: value.trim() });
  }
  return posts;
}

export function draftFromJson(body: unknown): DraftInput {
  if (!body || typeof body !== "object")
    throw new AppError(400, "Send a JSON object.");
  const record = body as Record<string, unknown>;
  const kind = parseKind(record.kind);
  if (!Array.isArray(record.segments) || record.segments.length === 0) {
    throw new AppError(422, "Add at least one segment.");
  }
  const segments: SegmentInput[] = record.segments.map((entry) => {
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
        if (typeof image.alt_text !== "string")
          throw new AppError(422, "Alt text is required.");
        if (
          typeof image.data_base64 !== "string" ||
          typeof image.mime !== "string"
        ) {
          throw new AppError(422, "An image needs mime and data_base64.");
        }
        if (!isImageMime(image.mime))
          throw new AppError(422, "Images must be PNG, JPEG, GIF, or WebP.");
        if (decodedBase64Length(image.data_base64) > 5 * 1024 * 1024) {
          throw new AppError(422, "Each image must be 5 MB or smaller.");
        }
        media.push({
          altText: image.alt_text,
          mime: image.mime,
          bytes: base64ToBytes(image.data_base64),
        });
      }
    }
    return { text: segment.text, media };
  });
  return {
    kind,
    title: typeof record.title === "string" ? record.title : null,
    notes: typeof record.notes === "string" ? record.notes : null,
    reviewedBy: null,
    segments,
  };
}

export function wantsHtml(
  contentType: string | undefined,
  accept: string | undefined,
): boolean {
  if ((contentType ?? "").includes("application/json")) return false;
  if (
    (accept ?? "").includes("application/json") &&
    !(accept ?? "").includes("text/html")
  )
    return false;
  return true;
}
