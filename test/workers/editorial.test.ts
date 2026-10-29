import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  asUser,
  auth,
  connectX,
  type ItemJson,
  intakeCall,
  ORIGIN,
  readItem,
  send,
} from "./helpers";
import { resetX } from "./mock-x";

beforeEach(() => {
  resetX();
});

describe("editorial stages", () => {
  it("lets intake set needs Hemingway or needs your approval and nothing else", async () => {
    const created = await intakeCall("POST", "/api/intake/drafts", {
      kind: "post",
      stage: "needs_hemingway",
      segments: [{ text: "Needs an editor" }],
    });
    expect(created.status).toBe(201);
    const item = ((await created.json()) as { item: ItemJson }).item;
    expect(item.status).toBe("draft");
    expect(item.review_stage).toBe("needs_hemingway");

    const moved = await intakeCall("PATCH", `/api/intake/drafts/${item.id}`, {
      stage: "needs_approval",
    });
    expect(moved.status).toBe(200);
    const awaiting = ((await moved.json()) as { item: ItemJson }).item;
    expect(awaiting.status).toBe("draft");
    expect(awaiting.review_stage).toBe("needs_approval");
    expect(awaiting.content_hash).toBe(item.content_hash);
    expect(awaiting.approved_hash).toBeNull();

    for (const stage of ["approved", "scheduled", "posted", "draft"]) {
      const bad = await intakeCall("PATCH", `/api/intake/drafts/${item.id}`, {
        stage,
      });
      expect(bad.status, stage).toBe(422);
    }
    const badCreate = await intakeCall("POST", "/api/intake/drafts", {
      kind: "post",
      stage: "approved",
      segments: [{ text: "Sneaky" }],
    });
    expect(badCreate.status).toBe(422);

    const approve = await intakeCall("POST", `/api/items/${item.id}/approve`, {
      expected_hash: item.content_hash,
    });
    expect(approve.status).toBe(403);
    const formApprove = await intakeCall("POST", `/items/${item.id}/approve`);
    expect(formApprove.status).toBe(403);

    const session = await asUser();
    const after = await readItem(session, item.id);
    expect(after.status).toBe("draft");
    expect(after.review_stage).toBe("needs_approval");
  });

  it("filters the dashboard and approves from it with the content hash", async () => {
    const hemingway = await intakeCall("POST", "/api/intake/drafts", {
      kind: "post",
      stage: "needs_hemingway",
      segments: [{ text: "Hemingway has not read this" }],
    });
    expect(hemingway.status).toBe(201);
    const waiting = await intakeCall("POST", "/api/intake/drafts", {
      kind: "thread",
      stage: "needs_approval",
      segments: [{ text: "Please read this" }, { text: "Second post" }],
    });
    const item = ((await waiting.json()) as { item: ItemJson }).item;
    const session = await asUser();

    const page = await send(session, "/?status=needs_approval", "GET");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Please read this");
    expect(html).toContain("Second post");
    expect(html).not.toContain("Hemingway has not read this");
    expect(html).toContain(`value="${item.content_hash}"`);
    expect(html).toContain("16 / 280");

    const all = await (await send(session, "/", "GET")).text();
    expect(all).toContain("Hemingway has not read this");
    expect(all).toContain("Please read this");

    const stale = await SELF.fetch(`${ORIGIN}/items/${item.id}/approve`, {
      method: "POST",
      headers: auth(session, {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      }),
      body: new URLSearchParams({
        csrf: session.csrf,
        expected_hash: "0".repeat(64),
        back: "needs_approval",
      }).toString(),
      redirect: "manual",
    });
    expect(stale.status).toBe(409);
    expect((await readItem(session, item.id)).status).toBe("draft");

    await connectX();
    const approved = await SELF.fetch(`${ORIGIN}/items/${item.id}/approve`, {
      method: "POST",
      headers: auth(session, {
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: new URLSearchParams({
        csrf: session.csrf,
        expected_hash: item.content_hash,
        back: "needs_approval",
      }).toString(),
      redirect: "manual",
    });
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toBe(
      `/?status=needs_approval&notice=approved#item-${item.id}`,
    );
    const next = await readItem(session, item.id);
    expect(next.status).toBe("approved");
    expect(next.approved_hash).toBe(item.content_hash);
    expect(next.scheduled_at).toBeNull();

    const patch = await intakeCall("PATCH", `/api/intake/drafts/${item.id}`, {
      stage: "needs_hemingway",
    });
    expect(patch.status).toBe(403);
  });

  it("puts an awaiting item back to plain draft when you edit the text", async () => {
    const created = await intakeCall("POST", "/api/intake/drafts", {
      kind: "post",
      stage: "needs_approval",
      segments: [{ text: "Before the edit" }],
    });
    const item = ((await created.json()) as { item: ItemJson }).item;
    const session = await asUser();
    const edited = await send(session, `/api/items/${item.id}`, "PATCH", {
      kind: "post",
      segments: [{ text: "After the edit" }],
    });
    const next = ((await edited.json()) as { item: ItemJson }).item;
    expect(next.status).toBe("draft");
    expect(next.review_stage).toBe("draft");
  });
});
