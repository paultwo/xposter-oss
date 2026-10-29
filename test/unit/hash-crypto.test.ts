import { describe, expect, it } from "vitest";
import {
  decryptString,
  encryptString,
  timingSafeEqual,
  timingSafeEqualText,
  tokenMatches,
} from "../../src/lib/crypto";
import { canonicalJson, contentHash } from "../../src/lib/hash";
import { log, scrub } from "../../src/lib/log";

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

describe("content hash", () => {
  const left = {
    kind: "post" as const,
    title: null,
    segments: [
      {
        position: 1,
        text: "second",
        media: [
          { altText: "zed", mime: "image/png", r2Key: "media/b" },
          { altText: "aye", mime: "image/png", r2Key: "media/a" },
        ],
      },
      { position: 0, text: "first", media: [] },
    ],
  };
  const right = {
    kind: "post" as const,
    title: null,
    segments: [
      { position: 0, text: "first", media: [] },
      {
        position: 1,
        text: "second",
        media: [
          { altText: "aye", mime: "image/png", r2Key: "media/a" },
          { altText: "zed", mime: "image/png", r2Key: "media/b" },
        ],
      },
    ],
  };

  it("sorts segments by position and keeps image order", async () => {
    const swappedSegments = {
      ...left,
      segments: [left.segments[1], left.segments[0]],
    };
    expect(canonicalJson(left)).toBe(canonicalJson(swappedSegments));
    expect(await contentHash(left)).toBe(await contentHash(swappedSegments));
    expect(canonicalJson(left)).not.toBe(canonicalJson(right));
    expect(await contentHash(left)).not.toBe(await contentHash(right));
  });

  it("changes when text, alt text, or kind changes", async () => {
    const base = await contentHash(left);
    const edited = await contentHash({
      ...left,
      segments: [
        { ...left.segments[1], position: 0, text: "edited", media: [] },
        left.segments[0],
      ],
    });
    const article = await contentHash({
      ...left,
      kind: "article",
      title: "Title",
    });
    expect(edited).not.toBe(base);
    expect(article).not.toBe(base);
  });
});

describe("aes and constant time", () => {
  it("round trips and uses a fresh iv", async () => {
    const first = await encryptString(KEY, "access-token-value");
    const second = await encryptString(KEY, "access-token-value");
    expect(first.iv).not.toBe(second.iv);
    expect(await decryptString(KEY, first.cipher, first.iv)).toBe(
      "access-token-value",
    );
  });

  it("compares tokens without early length leaks in the result", async () => {
    const same = new TextEncoder().encode("abcdef");
    expect(timingSafeEqual(same, same)).toBe(true);
    expect(timingSafeEqual(same, new TextEncoder().encode("abcdeg"))).toBe(
      false,
    );
    expect(timingSafeEqual(same, new TextEncoder().encode("abc"))).toBe(false);
    expect(timingSafeEqualText("same", "same")).toBe(true);
    expect(
      await tokenMatches(
        "intake",
        await crypto.subtle
          .digest("SHA-256", new TextEncoder().encode("intake"))
          .then((buf) =>
            [...new Uint8Array(buf)]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
          ),
      ),
    ).toBe(true);
    expect(await tokenMatches("intake", "0".repeat(64))).toBe(false);
  });
});

describe("logs", () => {
  it("drops secret fields and redacts bearer values", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    log("info", "x_connected", {
      username: "exampleuser",
      access_token: "should-drop",
      note: "bearer abcdefghijklmnopqrstuvwxyz012345",
    });
    console.log = original;
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, string>;
    expect(parsed.username).toBe("exampleuser");
    expect(parsed.access_token).toBeUndefined();
    expect(parsed.note).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(scrub("bearer secret-value")).toBe("bearer [redacted]");
    expect(scrub("write you@example.com or 555-123-4567")).toBe(
      "write [redacted] or [redacted]",
    );
    expect(scrub("X returned 500")).toBe("X returned 500");
  });
});
