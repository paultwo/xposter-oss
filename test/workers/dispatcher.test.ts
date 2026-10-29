import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { SCOPE_STRING } from "../../src/lib/scopes";
import { dispatch } from "../../src/posting/dispatch";
import { disconnectAccount, saveTokenBundle } from "../../src/x/account";
import { X_TIMEOUT_DETAIL } from "../../src/x/client";
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

function visible(html: string): string {
  return html
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

beforeEach(() => {
  resetX();
});

describe("dispatcher", () => {
  it("posts one scheduled item from the cron handler", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "One post" }],
    });
    await approveAndSchedule(session, item);
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({
        scheduledTime: new Date(),
        cron: "* * * * *",
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("posted");
    expect(saved.segments[0]?.x_post_id).toBe("1000");
    expect(xstate.tweets).toEqual([
      { text: "One post", replyTo: null, mediaIds: [] },
    ]);
    expect(
      xstate.paths.some(
        (path) => path.startsWith("/2/dm") || path.startsWith("/2/chat"),
      ),
    ).toBe(false);
  });

  it("posts a thread in order and keeps the reply chain", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "thread",
      segments: [
        { text: "One" },
        { text: "Two" },
        { text: "Three" },
        { text: "Four" },
        { text: "Five" },
      ],
    });
    await approveAndSchedule(session, item);
    const replies: Array<string | null> = [];
    for (let step = 0; step < 5; step++) {
      const result = await dispatch(env, Date.now());
      expect(result.posted).toBe(1);
      replies.push(xstate.tweets.at(-1)?.replyTo ?? null);
      const mid = await readItem(session, item.id);
      expect(mid.segments.filter((segment) => segment.x_post_id).length).toBe(
        step + 1,
      );
    }
    expect(replies).toEqual([null, "1000", "1001", "1002", "1003"]);
    const saved = await readItem(session, item.id);
    expect(saved.segments.map((segment) => segment.x_post_id)).toEqual([
      "1000",
      "1001",
      "1002",
      "1003",
      "1004",
    ]);
  });

  it("uploads an image and sends its alt text", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [
        {
          text: "With image",
          media: [
            { alt_text: "A paper ledger", mime: "image/png", data_base64: PNG },
          ],
        },
      ],
    });
    await approveAndSchedule(session, item);
    await dispatch(env, Date.now());
    expect(xstate.alts).toEqual(["A paper ledger"]);
    expect(xstate.tweets[0]?.mediaIds.length).toBe(1);
    expect((await readItem(session, item.id)).status).toBe("posted");
  });

  it("creates an article draft and then publishes it", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "article",
      title: "A title",
      segments: [{ text: "# A title\n\nThe body." }],
    });
    await approveAndSchedule(session, item);
    await dispatch(env, Date.now());
    expect(xstate.articleTitles).toEqual(["A title"]);
    expect(xstate.publishes).toEqual(["/2/articles/art_1/publish"]);
    const saved = await readItem(session, item.id);
    expect(saved.x_article_id).toBe("art_1");
    expect(saved.segments[0]?.x_post_id).toBe("555");
    expect(saved.status).toBe("posted");
  });

  it("retries a rate limit on a later cron", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Later" }],
    });
    await approveAndSchedule(session, item);
    const reset = Math.floor(Date.now() / 1000) + 30;
    xstate.onTweet = (index) =>
      index === 0
        ? {
            statusCode: 429,
            data: "",
            responseOptions: {
              headers: { "x-rate-limit-reset": String(reset) },
            },
          }
        : { statusCode: 201, data: JSON.stringify({ data: { id: "77" } }) };
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect((await readItem(session, item.id)).status).toBe("scheduled");
    xstate.onTweet = null;
    expect((await dispatch(env, (reset + 1) * 1000)).posted).toBe(1);
    expect((await readItem(session, item.id)).status).toBe("posted");
  });

  it("refreshes once after a 401 and then posts", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Refresh me" }],
    });
    await approveAndSchedule(session, item);
    xstate.onTweet = (index) =>
      index === 0
        ? { statusCode: 401, data: "" }
        : { statusCode: 201, data: JSON.stringify({ data: { id: "88" } }) };
    expect((await dispatch(env, Date.now())).posted).toBe(1);
    expect(
      xstate.paths.filter((path) => path === "/2/oauth2/token").length,
    ).toBe(1);
    expect((await readItem(session, item.id)).segments[0]?.x_post_id).toBe(
      "88",
    );
  });

  it("fails closed when X reports empty credits", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "No credits" }],
    });
    await approveAndSchedule(session, item);
    xstate.onTweet = () => ({ statusCode: 402, data: "" });
    await dispatch(env, Date.now());
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("needs_you");
    expect(saved.needs_reason).toBe("rejected");
    expect(saved.last_error).toBe("X API credits are empty.");
  });

  it("lets only one of two overlapping crons post", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Once" }],
    });
    await approveAndSchedule(session, item);
    const now = Date.now();
    const [left, right] = await Promise.all([
      dispatch(env, now),
      dispatch(env, now),
    ]);
    expect(left.posted + right.posted).toBe(1);
    expect(xstate.tweets).toHaveLength(1);
    expect((await readItem(session, item.id)).status).toBe("posted");
  });

  it("moves a stale lease to needs review", async () => {
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Stale" }],
    });
    await env.DB.prepare(
      "UPDATE items SET status = 'posting', lease_until = ?, lease_id = 'old' WHERE id = ?",
    )
      .bind(Date.now() - 1000, item.id)
      .run();
    await dispatch(env, Date.now());
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("needs_you");
    expect(saved.needs_reason).toBe("unknown");
    expect(saved.last_error).not.toMatch(/timed out/i);
    expect(xstate.paths.filter((path) => path === "/2/tweets")).toEqual([]);
    const history = visible(
      await (await send(session, "/history", "GET")).text(),
    );
    const at = history.indexOf("<h2>Stale</h2>");
    expect(at).toBeGreaterThan(-1);
    const slice = history.slice(at, at + 800);
    expect(slice).toContain(
      "We don't know if this post went out. Check X before you send it again.",
    );
    expect(slice).not.toMatch(/timed out/i);
  });

  it("skips while another dispatch holds the lock", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Waiting on the lock" }],
    });
    await approveAndSchedule(session, item);
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE app_settings SET dispatch_lease_id = ?, dispatch_lease_until = ? WHERE id = 1",
    )
      .bind("held", now + 60_000)
      .run();
    expect(await dispatch(env, now)).toEqual({
      posted: 0,
      skipped: "dispatch_running",
    });
    expect(xstate.tweets).toEqual([]);
    await env.DB.prepare(
      "UPDATE app_settings SET dispatch_lease_id = NULL, dispatch_lease_until = NULL WHERE id = 1",
    ).run();
    expect((await dispatch(env, now)).posted).toBe(1);
  });

  it("does not hand an approved queue to a different X account", async () => {
    const session = await asUser();
    await connectX();
    const due = await createItem(session, {
      kind: "post",
      segments: [{ text: "Approved for the first account" }],
    });
    await approveAndSchedule(session, due, Date.now() - 1000);
    const later = await createItem(session, {
      kind: "post",
      segments: [{ text: "Also approved for the first account" }],
    });
    await approveAndSchedule(session, later, Date.now() + 86_400_000);
    xstate.userId = "888";
    await saveTokenBundle(
      env,
      {
        accessToken: "second-access",
        refreshToken: "second-refresh",
        expiresIn: 7200,
        scope: SCOPE_STRING,
      },
      {
        id: "888",
        username: "other",
        displayName: "Other",
        subscriptionType: "Premium",
      },
      Date.now(),
    );
    expect(xstate.paths).toContain("/2/oauth2/revoke");
    expect((await readItem(session, due.id)).status).toBe("draft");
    expect((await readItem(session, due.id)).approved_hash).toBeNull();
    expect((await readItem(session, later.id)).approved_hash).toBeNull();
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect(xstate.tweets).toEqual([]);
  });

  it("clears the old queue when a different account connects after disconnect", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Still approved after disconnect" }],
    });
    await approveAndSchedule(session, item, Date.now() + 86_400_000);
    await disconnectAccount(env);
    xstate.paths = [];
    xstate.userId = "888";
    await saveTokenBundle(
      env,
      {
        accessToken: "second-access",
        refreshToken: "second-refresh",
        expiresIn: 7200,
        scope: SCOPE_STRING,
      },
      {
        id: "888",
        username: "other",
        displayName: "Other",
        subscriptionType: "Premium",
      },
      Date.now(),
    );
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("draft");
    expect(saved.approved_hash).toBeNull();
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect(xstate.tweets).toEqual([]);
  });

  it("marks an item that comes due while X is disconnected", async () => {
    const session = await asUser();
    await connectX();
    const due = await createItem(session, {
      kind: "post",
      segments: [{ text: "Due at disconnect" }],
    });
    await approveAndSchedule(session, due, Date.now() - 1000);
    const waiting = await createItem(session, {
      kind: "post",
      segments: [{ text: "Comes due while disconnected" }],
    });
    await approveAndSchedule(session, waiting, Date.now() + 60_000);
    await disconnectAccount(env);
    expect((await readItem(session, due.id)).missed).toBe(true);
    expect((await readItem(session, waiting.id)).missed).toBe(false);
    await env.DB.prepare("UPDATE items SET scheduled_at = ? WHERE id = ?")
      .bind(Date.now() - 500, waiting.id)
      .run();
    expect(await dispatch(env, Date.now())).toEqual({
      posted: 0,
      skipped: "needs_reconnect",
    });
    expect((await readItem(session, waiting.id)).missed).toBe(true);
    expect((await readItem(session, waiting.id)).status).toBe("scheduled");
    expect(xstate.tweets).toEqual([]);
  });

  it("does not post a thread that is still posting onto a new account", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "thread",
      segments: [
        { text: "First on the old account" },
        { text: "Second stays unsent" },
      ],
    });
    await approveAndSchedule(session, item);
    expect((await dispatch(env, Date.now())).posted).toBe(1);
    await env.DB.prepare(
      `UPDATE items SET status = 'posting', lease_id = 'lease-mid', lease_until = ?,
         resend_segment_id = (
           SELECT id FROM segments WHERE item_id = ? AND x_post_id IS NULL ORDER BY position LIMIT 1
         )
       WHERE id = ?`,
    )
      .bind(Date.now() + 60_000, item.id, item.id)
      .run();
    xstate.paths = [];
    xstate.userId = "888";
    await saveTokenBundle(
      env,
      {
        accessToken: "second-access",
        refreshToken: "second-refresh",
        expiresIn: 7200,
        scope: SCOPE_STRING,
      },
      {
        id: "888",
        username: "other",
        displayName: "Other",
        subscriptionType: "Premium",
      },
      Date.now(),
    );
    const mid = await env.DB.prepare(
      "SELECT status, approved_hash, pending_resolution FROM items WHERE id = ?",
    )
      .bind(item.id)
      .first<{
        status: string;
        approved_hash: string | null;
        pending_resolution: string | null;
      }>();
    expect(mid?.status).toBe("posting");
    expect(mid?.approved_hash).not.toBeNull();
    expect(mid?.pending_resolution).toBe("account_switch");
    await env.DB.prepare("UPDATE items SET lease_until = ? WHERE id = ?")
      .bind(Date.now() - 1000, item.id)
      .run();
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("needs_you");
    expect(saved.needs_reason).toBe("unknown");
    const bound = await env.DB.prepare(
      "SELECT approved_x_user_id FROM items WHERE id = ?",
    )
      .bind(item.id)
      .first<{ approved_x_user_id: string | null }>();
    expect(bound?.approved_x_user_id).toBe("999");
    expect(xstate.tweets.map((tweet) => tweet.text)).toEqual([
      "First on the old account",
    ]);
  });

  it("does not retry a 401 with a different X account", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Do not switch mid post" }],
    });
    await approveAndSchedule(session, item);
    xstate.userId = "888";
    xstate.onTweet = () => ({ statusCode: 401, data: "" });
    await dispatch(env, Date.now());
    expect(xstate.paths.filter((path) => path === "/2/tweets")).toEqual([
      "/2/tweets",
    ]);
    const row = await env.DB.prepare(
      "SELECT x_user_id, needs_reconnect FROM oauth_account WHERE id = 1",
    ).first<{ x_user_id: string; needs_reconnect: number }>();
    expect(row?.x_user_id).toBe("999");
    expect(row?.needs_reconnect).toBe(1);
    expect(xstate.paths).toContain("/2/oauth2/revoke");
    expect(xstate.tweets).toHaveLength(1);
  });

  it("makes no X calls when posting is disabled", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Held" }],
    });
    await approveAndSchedule(session, item);
    const previous = env.POSTING_ENABLED;
    env.POSTING_ENABLED = "false";
    try {
      const result = await dispatch(env, Date.now());
      expect(result).toEqual({ posted: 0, skipped: "posting_disabled" });
      expect(xstate.paths).toEqual([]);
      expect((await readItem(session, item.id)).status).toBe("scheduled");
    } finally {
      env.POSTING_ENABLED = previous;
    }
  });

  it("does not retry a 401 after posting was paused during the refresh", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Pause before the retry" }],
    });
    await approveAndSchedule(session, item);
    const original = globalThis.fetch;
    let tweetCalls = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/2/tweets")) {
        tweetCalls += 1;
        await env.DB.prepare(
          "UPDATE app_settings SET posting_paused = 1 WHERE id = 1",
        ).run();
        return new Response("", { status: 401 });
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      await dispatch(env, Date.now());
    } finally {
      globalThis.fetch = original;
      await resetPostingGate();
    }
    expect(tweetCalls).toBe(1);
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("scheduled");
    expect(saved.missed).toBe(true);
    expect(saved.segments[0]?.x_post_id).toBeNull();
  });

  it("keeps a received 201 when the account switches during the send", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Posted during the switch" }],
    });
    await approveAndSchedule(session, item);
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/2/tweets")) {
        xstate.userId = "888";
        await saveTokenBundle(
          env,
          {
            accessToken: "second-access",
            refreshToken: "second-refresh",
            expiresIn: 7200,
            scope: SCOPE_STRING,
          },
          {
            id: "888",
            username: "other",
            displayName: "Other",
            subscriptionType: "Premium",
          },
          Date.now(),
        );
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      expect((await dispatch(env, Date.now())).posted).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("posted");
    expect(saved.segments[0]?.x_post_id).toBeTruthy();
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect(xstate.tweets.map((tweet) => tweet.text)).toEqual([
      "Posted during the switch",
    ]);
  });

  it("does not turn a 500 during an account switch into a draft", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Failed during the switch" }],
    });
    await approveAndSchedule(session, item);
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/2/tweets")) {
        xstate.userId = "888";
        await saveTokenBundle(
          env,
          {
            accessToken: "second-access",
            refreshToken: "second-refresh",
            expiresIn: 7200,
            scope: SCOPE_STRING,
          },
          {
            id: "888",
            username: "other",
            displayName: "Other",
            subscriptionType: "Premium",
          },
          Date.now(),
        );
        return new Response("", { status: 500 });
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      expect((await dispatch(env, Date.now())).posted).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("needs_you");
    expect(saved.needs_reason).toBe("unknown");
    const attempt = await env.DB.prepare(
      "SELECT outcome FROM post_attempts WHERE item_id = ? ORDER BY started_at DESC LIMIT 1",
    )
      .bind(item.id)
      .first<{ outcome: string | null }>();
    expect(attempt?.outcome).toBeNull();
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect(xstate.tweets).toEqual([]);
  });

  it("does not turn a timeout during an account switch into a draft", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Timed out during the switch" }],
    });
    await approveAndSchedule(session, item);
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/2/tweets")) {
        xstate.userId = "888";
        await saveTokenBundle(
          env,
          {
            accessToken: "second-access",
            refreshToken: "second-refresh",
            expiresIn: 7200,
            scope: SCOPE_STRING,
          },
          {
            id: "888",
            username: "other",
            displayName: "Other",
            subscriptionType: "Premium",
          },
          Date.now(),
        );
        await new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      expect((await dispatch(env, Date.now())).posted).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("needs_you");
    expect(saved.needs_reason).toBe("unknown");
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect(xstate.tweets).toEqual([]);
  });

  it("posts items behind a slot that is older than 24 hours", async () => {
    const session = await asUser();
    await connectX();
    const first = await createItem(session, {
      kind: "post",
      segments: [{ text: "Behind a stale slot" }],
    });
    const second = await createItem(session, {
      kind: "post",
      segments: [{ text: "After the stale slot" }],
    });
    await approveAndSchedule(session, first, Date.now() - 5_000);
    await approveAndSchedule(session, second, Date.now() - 1_000);
    const segment = await env.DB.prepare(
      "SELECT id FROM segments WHERE item_id = ? LIMIT 1",
    )
      .bind(first.id)
      .first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO daily_slots (id, day_key, segment_id, state, created_at)
       VALUES ('slot-stale', '2000-01-01', ?, 'held', ?)`,
    )
      .bind(segment?.id, Date.now() - 48 * 60 * 60 * 1000)
      .run();
    const result = await dispatch(env, Date.now());
    expect(result).toEqual({ posted: 2, skipped: null });
    expect(xstate.tweets.map((tweet) => tweet.text)).toEqual([
      "Behind a stale slot",
      "After the stale slot",
    ]);
    const stale = await env.DB.prepare(
      "SELECT id FROM daily_slots WHERE id = 'slot-stale'",
    ).first();
    expect(stale).toBeNull();
  });

  it("does not stop the queue on one in-window hold", async () => {
    const session = await asUser();
    await connectX();
    const blocked = await createItem(session, {
      kind: "post",
      segments: [{ text: "Held in the window" }],
    });
    const next = await createItem(session, {
      kind: "post",
      segments: [{ text: "Posts behind the hold" }],
    });
    await approveAndSchedule(session, blocked, Date.now() - 5_000);
    await approveAndSchedule(session, next, Date.now() - 1_000);
    const segment = await env.DB.prepare(
      "SELECT id FROM segments WHERE item_id = ? LIMIT 1",
    )
      .bind(blocked.id)
      .first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO daily_slots (id, day_key, segment_id, state, created_at)
       VALUES ('slot-held', '2000-01-02', ?, 'held', ?)`,
    )
      .bind(segment?.id, Date.now())
      .run();
    const result = await dispatch(env, Date.now());
    expect(result.posted).toBeGreaterThanOrEqual(1);
    expect(result).not.toEqual({ posted: 0, skipped: null });
    expect((await readItem(session, blocked.id)).status).toBe("scheduled");
    expect((await readItem(session, next.id)).status).toBe("posted");
    expect(xstate.tweets.map((tweet) => tweet.text)).toContain(
      "Posts behind the hold",
    );
    expect(xstate.tweets.map((tweet) => tweet.text)).not.toContain(
      "Held in the window",
    );
  });

  it("does not publish an unknown article a second time", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "article",
      title: "Already drafted",
      segments: [{ text: "# Already drafted\n\nBody." }],
    });
    await approveAndSchedule(session, item);
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/2/articles/") && url.includes("/publish")) {
        return new Response("", { status: 500 });
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      expect((await dispatch(env, Date.now())).posted).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("needs_you");
    expect(saved.needs_reason).toBe("unknown");
    expect(saved.x_article_id).toBe("art_1");
    expect(saved.segments[0]?.x_post_id).toBeNull();
    await env.DB.prepare("UPDATE items SET lease_until = ? WHERE id = ?")
      .bind(Date.now() - 10_000, item.id)
      .run();
    const retry = await send(session, `/api/items/${item.id}/retry`, "POST", {
      confirm: true,
      position: 0,
    });
    expect(retry.status).toBe(409);
    expect(await retry.text()).toContain("will not be published again");
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect(xstate.publishes).toEqual([]);
  });

  it("a 500 from X does not say the post timed out", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Server error post" }],
    });
    await approveAndSchedule(session, item);
    xstate.onTweet = () => ({ statusCode: 500, data: "not-json" });
    await dispatch(env, Date.now());
    const saved = await readItem(session, item.id);
    expect(saved.needs_reason).toBe("unknown");
    expect(saved.last_error).toBe("X returned 500.");
    expect(saved.last_error).not.toMatch(/timed out/i);
    const history = visible(
      await (await send(session, "/history", "GET")).text(),
    );
    const at = history.indexOf("Server error post");
    expect(at).toBeGreaterThan(-1);
    const slice = history.slice(at, at + 800);
    expect(slice).toContain(
      "We don't know if this post went out. Check X before you send it again.",
    );
    expect(slice).not.toMatch(/timed out/i);
    expect(history).toContain("Post link");
    expect(history).toContain("It posted (paste its link)");
    expect(history).not.toContain("It posted. Paste its link.");
    const dash = visible(await (await send(session, "/", "GET")).text());
    const entryAt = dash.indexOf(`id="item-${item.id}"`);
    expect(entryAt).toBeGreaterThan(-1);
    const entry = dash.slice(entryAt, entryAt + 1800);
    expect(entry).toContain(
      "We don't know if this post went out. Check X before you send it again.",
    );
    expect(entry).not.toMatch(/timed out/i);
  });

  it("a 15s timeout that starts at :50 shows the next minute", async () => {
    const start = Date.parse("2026-10-23T21:00:50.000Z");
    let clock = start;
    const realNow = Date.now;
    Date.now = () => clock;
    const previousTimeout = env.X_FETCH_TIMEOUT_MS;
    env.X_FETCH_TIMEOUT_MS = "15000";
    const original = globalThis.fetch;
    try {
      const session = await asUser();
      await connectX();
      const item = await createItem(session, {
        kind: "post",
        segments: [{ text: "Timed out across the minute" }],
      });
      await approveAndSchedule(session, item, start - 1000);
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/2/tweets")) {
          await new Promise((_resolve, reject) => {
            const signal = init?.signal;
            const fail = () => {
              clock = start + 15_000;
              const reason = signal?.reason;
              reject(
                reason ??
                  new DOMException(
                    "The operation was aborted due to timeout",
                    "TimeoutError",
                  ),
              );
            };
            if (!signal || signal.aborted) {
              fail();
              return;
            }
            signal.addEventListener("abort", fail, { once: true });
          });
        }
        return original(input, init);
      }) as typeof fetch;
      await dispatch(env, start);
      const saved = await readItem(session, item.id);
      expect(saved.needs_reason).toBe("unknown");
      expect(saved.last_error).toBe(X_TIMEOUT_DETAIL);
      const row = await env.DB.prepare(
        "SELECT updated_at FROM items WHERE id = ?",
      )
        .bind(item.id)
        .first<{ updated_at: number }>();
      expect(row?.updated_at).toBe(start + 15_000);
      const history = visible(
        await (await send(session, "/history", "GET")).text(),
      );
      const at = history.indexOf("Timed out across the minute");
      expect(at).toBeGreaterThan(-1);
      const slice = history.slice(at, at + 800);
      expect(slice).toContain(
        "X timed out at 5:01 PM EDT. Check X to see whether it posted before you send it again.",
      );
      expect(slice).not.toContain("X timed out at 5:00 PM");
    } finally {
      Date.now = realNow;
      globalThis.fetch = original;
      env.X_FETCH_TIMEOUT_MS = previousTimeout;
    }
  }, 30_000);
});
