import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approveAndSchedule,
  asUser,
  connectX,
  createItem,
  type ItemJson,
  intakeHeaders,
  ORIGIN,
  readItem,
} from "./helpers";
import { resetX } from "./mock-x";

beforeEach(() => {
  resetX();
});

describe("intake", () => {
  it("creates only drafts, ignores injected state, and dedupes its own source ref", async () => {
    const headers = await intakeHeaders();
    const first = await SELF.fetch(`${ORIGIN}/api/intake/drafts`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "post",
        source_ref: "same-ref",
        status: "approved",
        approved_hash: "nope",
        scheduled_at: 1,
        segments: [{ text: "Bot draft" }],
      }),
    });
    expect(first.status).toBe(201);
    const created = ((await first.json()) as { item: ItemJson }).item;
    expect(created.status).toBe("draft");
    expect(created.approved_hash).toBeNull();
    expect(created.scheduled_at).toBeNull();
    expect(created.source).toBe("env:intake");
    const second = await SELF.fetch(`${ORIGIN}/api/intake/drafts`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "post",
        source_ref: "same-ref",
        segments: [{ text: "Other" }],
      }),
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { item: ItemJson }).item.id).toBe(
      created.id,
    );
  });

  it("cannot read another bot draft or patch a non-draft", async () => {
    const session = await asUser();
    const mine = await createItem(session, {
      kind: "post",
      segments: [{ text: "A bot draft" }],
    });
    const headers = await intakeHeaders();
    expect(
      (await SELF.fetch(`${ORIGIN}/api/intake/drafts/${mine.id}`, { headers }))
        .status,
    ).toBe(404);
    const bot = await SELF.fetch(`${ORIGIN}/api/intake/drafts`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "post", segments: [{ text: "Bot only" }] }),
    });
    const id = ((await bot.json()) as { item: ItemJson }).item.id;
    await connectX();
    await approveAndSchedule(
      session,
      await readItem(session, id),
      Date.now() + 60_000,
    );
    const patch = await SELF.fetch(`${ORIGIN}/api/intake/drafts/${id}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "post", segments: [{ text: "Changed" }] }),
    });
    expect(patch.status).toBe(403);
  });
});
