import { AppError, type MediaInput } from "./model";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ALT = 1000;

const MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMime = (typeof MIMES)[number];

export function isImageMime(value: string): value is ImageMime {
  return (MIMES as readonly string[]).includes(value);
}

export function sniffImage(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/png") {
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    );
  }
  if (mime === "image/jpeg")
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/gif")
    return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
  if (mime === "image/webp") {
    return (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  return false;
}

export function assertMediaSet(
  media: MediaInput[],
  segmentIndex: number,
): void {
  const label = `segment ${segmentIndex + 1}`;
  if (media.length > 4)
    throw new AppError(422, `${label} can have at most 4 images.`);
  const gifs = media.filter((entry) => entry.mime === "image/gif");
  if (gifs.length > 1 || (gifs.length === 1 && media.length > 1)) {
    throw new AppError(
      422,
      `${label} can have one GIF or up to 4 photos, not both.`,
    );
  }
  for (const [index, entry] of media.entries()) {
    if (!entry.altText.trim()) {
      throw new AppError(
        422,
        `Alt text is required for the image on ${label}.`,
        {
          [`alt_${segmentIndex}_${index}`]: "Alt text is required.",
        },
      );
    }
    if (entry.altText.length > MAX_ALT) {
      throw new AppError(422, "Alt text must be 1000 characters or fewer.");
    }
    if (!entry.existingId) {
      if (!isImageMime(entry.mime) || !sniffImage(entry.bytes, entry.mime)) {
        throw new AppError(422, "Images must be PNG, JPEG, GIF, or WebP.");
      }
      if (entry.bytes.byteLength > MAX_BYTES)
        throw new AppError(422, "Each image must be 5 MB or smaller.");
    }
  }
}
