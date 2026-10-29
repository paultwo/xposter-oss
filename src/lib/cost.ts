import type { Kind } from "./state";
import { containsUrl } from "./text";

const POST_THOUSANDTHS = 15;
const URL_POST_THOUSANDTHS = 200;
const ALT_THOUSANDTHS = 5;

export type CostSegment = {
  text: string;
  altCount: number;
  hasMedia: boolean;
};

export type CostEstimate = {
  thousandths: number;
  lines: string[];
  articleNote: boolean;
  mediaNote: boolean;
};

function money(thousandths: number): string {
  return `$${(thousandths / 1000).toFixed(3)}`;
}

export function estimateCost(
  kind: Kind,
  segments: CostSegment[],
): CostEstimate {
  const lines: string[] = [];
  let thousandths = 0;
  let mediaNote = false;
  for (const [index, segment] of segments.entries()) {
    const post = containsUrl(segment.text)
      ? URL_POST_THOUSANDTHS
      : POST_THOUSANDTHS;
    thousandths += post;
    const label = segments.length === 1 ? "Post" : `Segment ${index + 1}`;
    lines.push(
      `${label}: ${money(post)}${post === URL_POST_THOUSANDTHS ? ", includes a link" : ""}`,
    );
    if (segment.altCount > 0) {
      const alt = segment.altCount * ALT_THOUSANDTHS;
      thousandths += alt;
      lines.push(`Alt text for ${label.toLowerCase()}: ${money(alt)}`);
    }
    if (segment.hasMedia) mediaNote = true;
  }
  return {
    thousandths,
    lines,
    articleNote: kind === "article",
    mediaNote,
  };
}

export function formatDollars(thousandths: number): string {
  return money(thousandths);
}

export function costLine(estimate: CostEstimate): string {
  const rounded = (Math.round(estimate.thousandths / 10) / 100).toFixed(2);
  const aside = estimate.mediaNote
    ? " (image upload not included)"
    : estimate.articleNote
      ? " (Article publish not included)"
      : "";
  return `X API cost: about $${rounded}${aside}.`;
}
