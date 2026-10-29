import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "../../src/posting/dispatch";
import {
  approveAndSchedule,
  asUser,
  connectX,
  createItem,
  type ItemJson,
  postForm,
  readItem,
  send,
} from "./helpers";
import { resetX, xstate } from "./mock-x";

beforeEach(() => {
  resetX();
});

describe("approval", () => {
  it("returns an edited approved item to draft and clears the schedule", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Original line" }],
    });
    await approveAndSchedule(session, item, Date.now() + 3_600_000);
    const edited = await send(session, `/api/items/${item.id}`, "PATCH", {
      kind: "post",
      segments: [{ text: "Edited line" }],
    });
    expect(edited.status).toBe(200);
    const next = ((await edited.json()) as { item: ItemJson }).item;
    expect(next.status).toBe("draft");
    expect(next.approved_hash).toBeNull();
    expect(next.scheduled_at).toBeNull();
  });

  it("approves 280 characters and refuses 281 when the plan is not Premium", async () => {
    await env.DB.prepare(
      "UPDATE app_settings SET x_plan = 'none' WHERE id = 1",
    ).run();
    await connectX();
    const session = await asUser();
    const atLimit = await createItem(session, {
      kind: "post",
      segments: [{ text: "a".repeat(280) }],
    });
    const approved = await send(
      session,
      `/api/items/${atLimit.id}/approve`,
      "POST",
      { expected_hash: atLimit.content_hash },
    );
    expect(approved.status).toBe(200);
    const over = await createItem(session, {
      kind: "post",
      segments: [{ text: "a".repeat(281) }],
    });
    const refused = await send(
      session,
      `/api/items/${over.id}/approve`,
      "POST",
      {
        expected_hash: over.content_hash,
      },
    );
    expect(refused.status).toBe(422);
  });

  it("approves and posts a long post at the premium limit", async () => {
    await env.DB.prepare(
      "UPDATE app_settings SET x_plan = 'premium' WHERE id = 1",
    ).run();
    await connectX();
    const session = await asUser();
    const text = "a".repeat(25000);
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text }],
    });
    await approveAndSchedule(session, item);
    await dispatch(env, Date.now());
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("posted");
    expect(saved.segments[0]?.x_post_id).toBe("1000");
    expect(xstate.tweets[0]?.text).toBe(text);
  });

  it("refuses a post one character over the premium limit", async () => {
    await env.DB.prepare(
      "UPDATE app_settings SET x_plan = 'premium' WHERE id = 1",
    ).run();
    const session = await asUser();
    const response = await send(session, "/api/items", "POST", {
      kind: "post",
      segments: [{ text: "a".repeat(25001) }],
    });
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain("25,000");
  });

  it("does not let a premium override outrank the connected account", async () => {
    await connectX();
    await env.DB.prepare(
      "UPDATE oauth_account SET subscription_type = 'None' WHERE id = 1",
    ).run();
    await env.DB.prepare(
      "UPDATE app_settings SET x_plan = 'premium' WHERE id = 1",
    ).run();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "a".repeat(281) }],
    });
    const refused = await send(
      session,
      `/api/items/${item.id}/approve`,
      "POST",
      { expected_hash: item.content_hash },
    );
    expect(refused.status).toBe(422);
    const saved = await postForm(session, "/settings/preferences", {
      time_zone: "America/New_York",
      x_plan: "premium",
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain(
      "That plan is higher than the connected X account.",
    );
  });

  it("names the saved zone when a schedule time is missing", async () => {
    const session = await asUser();
    await connectX();
    await env.DB.prepare(
      "UPDATE app_settings SET time_zone = 'America/Chicago' WHERE id = 1",
    ).run();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Needs a time" }],
    });
    const approved = await send(
      session,
      `/api/items/${item.id}/approve`,
      "POST",
      { expected_hash: item.content_hash },
    );
    expect(approved.status).toBe(200);
    const scheduled = await send(
      session,
      `/api/items/${item.id}/schedule`,
      "POST",
      {},
    );
    expect(scheduled.status).toBe(422);
    const body = await scheduled.text();
    expect(body).toContain("CDT");
    expect(body).not.toContain("Eastern");
  });

  it("rejects a first schedule in the past and does not leave it due", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Not in the past" }],
    });
    const approved = await send(
      session,
      `/api/items/${item.id}/approve`,
      "POST",
      {
        expected_hash: item.content_hash,
      },
    );
    expect(approved.status).toBe(200);
    const scheduled = await send(
      session,
      `/api/items/${item.id}/schedule`,
      "POST",
      {
        scheduled_at: Date.now() - 60_000,
      },
    );
    expect(scheduled.status).toBe(422);
    expect(await scheduled.text()).toContain("future");
    expect((await readItem(session, item.id)).status).toBe("approved");
    const due = await env.DB.prepare(
      "SELECT id FROM items WHERE status = 'scheduled' AND missed = 0 AND scheduled_at <= ?",
    )
      .bind(Date.now())
      .all();
    expect(due.results ?? []).toEqual([]);
  });

  it("refuses approval with no X account, then leaves nothing due after connect", async () => {
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Approved before any account" }],
    });
    const approved = await send(
      session,
      `/api/items/${item.id}/approve`,
      "POST",
      {
        expected_hash: item.content_hash,
      },
    );
    expect(approved.status).toBe(409);
    expect((await readItem(session, item.id)).status).toBe("draft");
    await connectX();
    await env.DB.prepare(
      `UPDATE items SET status = 'scheduled', approved_hash = content_hash,
         approved_x_user_id = NULL, scheduled_at = ?, missed = 0 WHERE id = ?`,
    )
      .bind(Date.now() - 1000, item.id)
      .run();
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("needs_you");
    const due = await env.DB.prepare(
      "SELECT id FROM items WHERE status = 'scheduled' AND missed = 0 AND scheduled_at <= ?",
    )
      .bind(Date.now())
      .all();
    expect(due.results ?? []).toEqual([]);
    expect(xstate.tweets).toEqual([]);
  });
});
