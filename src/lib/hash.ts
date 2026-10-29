import { sha256Hex } from "./crypto";
import type { Kind } from "./state";

export type CanonMedia = {
  altText: string;
  mime: string;
  r2Key: string;
};

export type CanonSegment = {
  position: number;
  text: string;
  media: CanonMedia[];
};

export type CanonContent = {
  kind: Kind;
  title: string | null;
  segments: CanonSegment[];
};

export function canonicalJson(content: CanonContent): string {
  const segments = [...content.segments]
    .sort((left, right) => left.position - right.position)
    .map((segment) => ({
      media: segment.media.map((media) => ({
        alt_text: media.altText,
        mime: media.mime,
        r2_key: media.r2Key,
      })),
      position: segment.position,
      text: segment.text,
    }));
  return JSON.stringify({
    kind: content.kind,
    segments,
    title: content.title,
  });
}

export async function contentHash(content: CanonContent): Promise<string> {
  return sha256Hex(canonicalJson(content));
}
