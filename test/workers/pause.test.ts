import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "../../src/posting/dispatch";
import {
  approveAndSchedule,
  asUser,
  connectX,
  createItem,
  PNG,
  readItem,
  resetPostingGate,
  send,
} from "./helpers";
import { resetX, xstate } from "./mock-x";

beforeEach(() => {
  resetX();
});

describe("pause flag and missed items", () => {
  beforeEach(async () => {
    await resetPostingGate();
    env.POSTING_ENABLED = "true";
    await env.DB.prepare(
      "UPDATE items SET missed = 1 WHERE status = 'scheduled' AND missed = 0",
    ).run();
  });

  it("pauses from the app and has no route that turns posting back on", async () => {
    const session = await asUser();
    await connectX();
    const later = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const waiting = await createItem(session, {
      kind: "post",
      segments: [{ text: "Still in the future" }],
    });
    await approveAndSchedule(session, waiting, later);
    const due = await createItem(session, {
      kind: "post",
      segments: [{ text: "Due while paused" }],
    });
    await approveAndSchedule(session, due, Date.now() - 1000);
    const paused = await send(session, "/api/settings/pause", "POST");
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ posting_paused: true });
    const resume = await send(session, "/api/settings/resume", "POST");
    expect(resume.status).toBe(404);
    const held = await dispatch(env, Date.now());
    expect(held).toEqual({ posted: 0, skipped: "posting_disabled" });
    expect(xstate.paths.filter((path) => path === "/2/tweets")).toEqual([]);
    expect((await readItem(session, waiting.id)).missed).toBe(false);
    const missed = await readItem(session, due.id);
    expect(missed.status).toBe("scheduled");
    expect(missed.missed).toBe(true);
    await env.DB.prepare(
      "UPDATE app_settings SET posting_paused = 0 WHERE id = 1",
    ).run();
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect((await readItem(session, due.id)).missed).toBe(true);
    expect(xstate.tweets).toEqual([]);
  });

  it("re-reads the pause gate before each item", async () => {
    const session = await asUser();
    await connectX();
    const first = await createItem(session, {
      kind: "post",
      segments: [{ text: "First due" }],
    });
    const second = await createItem(session, {
      kind: "post",
      segments: [{ text: "Second due" }],
    });
    const now = Date.now();
    await approveAndSchedule(session, first, now - 2000);
    await approveAndSchedule(session, second, now - 1000);
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const response = await original(input, init);
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/2/tweets")) {
        await env.DB.prepare(
          "UPDATE app_settings SET posting_paused = 1 WHERE id = 1",
        ).run();
      }
      return response;
    }) as typeof fetch;
    try {
      await dispatch(env, now);
    } finally {
      globalThis.fetch = original;
    }
    expect(xstate.tweets.map((tweet) => tweet.text)).toEqual(["First due"]);
    const held = await readItem(session, second.id);
    expect(held.status).toBe("scheduled");
    expect(held.missed).toBe(true);
  });

  it("does not auto-post a missed item after posting returns, until you reschedule", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Missed the window" }],
    });
    await approveAndSchedule(session, item, Date.now() - 1000);
    const future = await createItem(session, {
      kind: "post",
      segments: [{ text: "Not due yet" }],
    });
    const futureAt = Date.now() + 3 * 60 * 60 * 1000;
    await approveAndSchedule(session, future, futureAt);
    env.POSTING_ENABLED = "false";
    expect(await dispatch(env, Date.now())).toEqual({
      posted: 0,
      skipped: "posting_disabled",
    });
    const marked = await readItem(session, item.id);
    expect(marked.status).toBe("scheduled");
    expect(marked.missed).toBe(true);
    expect((await readItem(session, future.id)).missed).toBe(false);
    expect(xstate.tweets).toEqual([]);
    env.POSTING_ENABLED = "true";
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect((await readItem(session, item.id)).missed).toBe(true);
    expect((await readItem(session, future.id)).missed).toBe(false);
    expect(xstate.tweets).toEqual([]);
    const tooSoon = await send(
      session,
      `/api/items/${item.id}/reschedule`,
      "POST",
      {
        scheduled_at: Date.now() - 1000,
      },
    );
    expect(tooSoon.status).toBe(422);
    const when = Date.now() + 60 * 60 * 1000;
    const moved = await send(
      session,
      `/api/items/${item.id}/reschedule`,
      "POST",
      {
        scheduled_at: when,
      },
    );
    expect(moved.status).toBe(200);
    expect((await readItem(session, item.id)).missed).toBe(false);
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect((await dispatch(env, when + 1000)).posted).toBe(1);
    expect((await readItem(session, item.id)).status).toBe("posted");
    expect(xstate.tweets.map((tweet) => tweet.text)).toEqual([
      "Missed the window",
    ]);
  });

  it("still posts an item that is only a second overdue while posting stayed on", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "A second late" }],
    });
    await approveAndSchedule(session, item, Date.now() - 1000);
    expect((await dispatch(env, Date.now())).posted).toBe(1);
    expect((await readItem(session, item.id)).status).toBe("posted");
  });

  it("records one pasted status link and does not resend that post", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "thread",
      segments: [
        { text: "S1" },
        { text: "S2" },
        { text: "S3" },
        { text: "S4" },
      ],
    });
    await approveAndSchedule(session, item);
    expect((await dispatch(env, Date.now())).posted).toBe(1);
    expect((await dispatch(env, Date.now())).posted).toBe(1);
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/2/tweets")) {
        return Promise.reject(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          ),
        );
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      await dispatch(env, Date.now());
    } finally {
      globalThis.fetch = original;
    }
    const paused = await readItem(session, item.id);
    expect(paused.status).toBe("needs_you");
    expect(paused.needs_reason).toBe("unknown");
    expect(paused.segments.map((segment) => segment.x_post_id)).toEqual([
      "1000",
      "1001",
      null,
      null,
    ]);
    const bare = await send(session, `/api/items/${item.id}/retry`, "POST", {
      position: 2,
    });
    expect(bare.status).toBe(409);
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect(xstate.tweets).toHaveLength(2);
    const bad = await send(session, `/api/items/${item.id}/mark-link`, "POST", {
      status_url: "https://example.com/exampleuser/status/1",
    });
    expect(bad.status).toBe(422);
    const marked = await send(
      session,
      `/api/items/${item.id}/mark-link`,
      "POST",
      {
        status_url: "https://x.com/exampleuser/status/424242",
      },
    );
    expect(marked.status).toBe(200);
    const after = await readItem(session, item.id);
    expect(after.segments[2]?.x_post_id).toBe("424242");
    expect(after.status).toBe("scheduled");
    await dispatch(env, Date.now());
    const done = await readItem(session, item.id);
    expect(done.status).toBe("posted");
    expect(done.segments.map((segment) => segment.x_post_id)).toEqual([
      "1000",
      "1001",
      "424242",
      "1002",
    ]);
    expect(xstate.tweets.map((tweet) => tweet.text)).toEqual([
      "S1",
      "S2",
      "S4",
    ]);
    expect(xstate.tweets.at(-1)?.replyTo).toBe("424242");
  });

  it("does not tweet when posting is paused during the upload", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [
        {
          text: "Photo that must not post",
          media: [{ alt_text: "Swatch", mime: "image/png", data_base64: PNG }],
        },
      ],
    });
    await approveAndSchedule(session, item);
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const response = await original(input, init);
      if (url.includes("/2/media/upload")) {
        await env.DB.prepare(
          "UPDATE app_settings SET posting_paused = 1 WHERE id = 1",
        ).run();
      }
      return response;
    }) as typeof fetch;
    try {
      await dispatch(env, Date.now());
    } finally {
      globalThis.fetch = original;
    }
    expect(xstate.tweets).toEqual([]);
    const saved = await readItem(session, item.id);
    expect(saved.segments[0]?.x_post_id).toBeNull();
    expect(saved.missed).toBe(true);
    const due = await env.DB.prepare(
      "SELECT id FROM items WHERE id = ? AND status = 'scheduled' AND missed = 0",
    )
      .bind(item.id)
      .all();
    expect(due.results ?? []).toEqual([]);
  });

  it("records the in-flight tweet when pause flips during /2/tweets and misses the next", async () => {
    const session = await asUser();
    await connectX();
    const now = Date.now();
    const first = await createItem(session, {
      kind: "post",
      segments: [{ text: "Already in flight" }],
    });
    const second = await createItem(session, {
      kind: "post",
      segments: [{ text: "Next due after the pause" }],
    });
    await approveAndSchedule(session, first, now - 2000);
    await approveAndSchedule(session, second, now - 1000);
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes("/2/tweets")) {
        await env.DB.prepare(
          "UPDATE app_settings SET posting_paused = 1 WHERE id = 1",
        ).run();
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      await dispatch(env, now);
    } finally {
      globalThis.fetch = original;
      await resetPostingGate();
    }
    expect(xstate.tweets.map((tweet) => tweet.text)).toEqual([
      "Already in flight",
    ]);
    const sent = await readItem(session, first.id);
    expect(sent.status).toBe("posted");
    expect(sent.segments[0]?.x_post_id).toBe("1000");
    const missed = await readItem(session, second.id);
    expect(missed.status).toBe("scheduled");
    expect(missed.missed).toBe(true);
    expect(missed.segments[0]?.x_post_id).toBeNull();
  });
});
