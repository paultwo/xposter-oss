import twitterText from "twitter-text";

// twitter-text replaces the whole config when any option is passed, so the
// fold uses the library's v3 weights and only the length comes from config.
const TWEET_CONFIG = {
  version: 3,
  maxWeightedTweetLength: 280,
  scale: 100,
  defaultWeight: 200,
  emojiParsingEnabled: true,
  transformedURLLength: 23,
  ranges: [
    { start: 0, end: 4351, weight: 100 },
    { start: 8192, end: 8205, weight: 100 },
    { start: 8208, end: 8223, weight: 100 },
    { start: 8242, end: 8247, weight: 100 },
  ],
};

export function weightedLength(text: string): number {
  return twitterText.parseTweet(text).weightedLength;
}

export function foldAt(
  text: string,
  showMoreAt: number,
): { head: string; rest: string } {
  const parsed = twitterText.parseTweet(text, {
    ...TWEET_CONFIG,
    maxWeightedTweetLength: showMoreAt,
  });
  if (parsed.valid || text.length === 0 || parsed.validRangeEnd < 0) {
    return { head: text, rest: "" };
  }
  const cut = parsed.validRangeEnd + 1;
  if (cut >= text.length) return { head: text, rest: "" };
  return { head: text.slice(0, cut), rest: text.slice(cut) };
}

export function containsUrl(text: string): boolean {
  return twitterText.extractUrls(text).length > 0;
}

export type IndexedUrl = { url: string; indices: [number, number] };

export function textUrls(text: string): IndexedUrl[] {
  return twitterText.extractUrlsWithIndices(text);
}

export function overLimitCopy(length: number, limit: number): string {
  const over = Math.max(0, length - limit).toLocaleString("en-US");
  return `Over by ${over}. Split it into a thread or make it an Article.`;
}

export class TextSplitError extends Error {
  constructor() {
    super("This text does not fit in 25 posts.");
    this.name = "TextSplitError";
  }
}

export function splitWeighted(text: string, limit: number): string[] {
  const parts: string[] = [];
  const tokens = text.split(/(\s+)/);
  let current = "";
  const flush = () => {
    const piece = current.trim();
    if (piece) parts.push(piece);
    current = "";
  };
  const guard = () => {
    if (parts.length >= 25) throw new TextSplitError();
  };
  for (const token of tokens) {
    if (parts.length >= 25) {
      if (current.trim() || token.trim()) throw new TextSplitError();
      continue;
    }
    const next = current + token;
    if (
      weightedLength(next.trim() === "" ? next : next.trim()) <= limit &&
      weightedLength(next) <= limit
    ) {
      current = next;
      continue;
    }
    if (current.trim()) flush();
    let rest = token.trim();
    if (rest && parts.length >= 25) throw new TextSplitError();
    if (!rest) continue;
    if (weightedLength(rest) <= limit) {
      current = rest;
      continue;
    }
    while (rest.length > 0) {
      guard();
      let take = 1;
      while (
        take < rest.length &&
        weightedLength(rest.slice(0, take + 1)) <= limit
      )
        take += 1;
      if (weightedLength(rest.slice(0, take)) > limit) take = 1;
      parts.push(rest.slice(0, take));
      rest = rest.slice(take).trimStart();
    }
    current = "";
  }
  if (current.trim()) {
    guard();
    flush();
  }
  return parts;
}
