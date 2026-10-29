import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/lib/crypto";
import { asUser, readItem, send } from "./helpers";
import { resetX } from "./mock-x";

beforeEach(() => {
  resetX();
});

describe("buffer import", () => {
  it("imports the five open drafts as drafts and keeps placeholders", async () => {
    expect(env.BUFFER_JSON.length).toBeGreaterThan(0);
    const session = await asUser();
    const response = await send(
      session,
      "/api/admin/import/buffer",
      "POST",
      JSON.parse(env.BUFFER_JSON),
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      created: number;
      items: Array<{
        id: string;
        sourceRef: string;
        textSha256: string;
        status: string;
      }>;
    };
    expect(result.created).toBe(5);
    expect(result.items.every((item) => item.status === "draft")).toBe(true);
    const exportPosts = (
      JSON.parse(env.BUFFER_JSON) as {
        posts_open: Array<{ id: string; text: string }>;
      }
    ).posts_open;
    for (const post of exportPosts) {
      const imported = result.items.find((item) => item.sourceRef === post.id);
      expect(imported?.textSha256).toBe(await sha256Hex(post.text));
      const saved = await readItem(session, imported?.id ?? "");
      expect(saved.segments[0]?.text).toBe(post.text);
      expect(saved.status).toBe("draft");
    }
    const placeholders = [
      "[what AI does]",
      "[what AI does, and never decides]",
      "[first pass, then a lawyer?]",
      "[your line]",
      "[One real work example, no names.]",
      "[Your take on earning it.]",
    ];
    const texts: string[] = [];
    for (const item of result.items)
      texts.push((await readItem(session, item.id)).segments[0]?.text ?? "");
    for (const placeholder of placeholders) {
      expect(
        texts.some((text) => text.includes(placeholder)),
        placeholder,
      ).toBe(true);
    }
    const long = result.items.find(
      (item) => item.sourceRef === "a00000000000000000000001",
    );
    expect((await readItem(session, long?.id ?? "")).notes).toBe(
      "Over 280: choose long post, thread, or Article",
    );
  });
});
