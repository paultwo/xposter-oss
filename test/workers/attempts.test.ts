import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createNamedToken } from "../../src/auth/intake";
import { encryptString } from "../../src/lib/crypto";
import { dispatch } from "../../src/posting/dispatch";
import { accessTokenForPosting } from "../../src/x/account";
import {
  approveAndSchedule,
  asUser,
  connectX,
  createItem,
  intakeHeaders,
  ORIGIN,
  PNG,
  postForm,
  readItem,
  send,
} from "./helpers";
import { resetX, xstate } from "./mock-x";

beforeEach(() => {
  resetX();
});

function tweetUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("one segment per attempt", () => {
  it("stops when the lease is swept during a multi-image upload", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "thread",
      segments: [
        {
          text: "Images",
          media: [
            { alt_text: "First", mime: "image/png", data_base64: PNG },
            { alt_text: "Second", mime: "image/png", data_base64: PNG },
          ],
        },
        { text: "Next" },
      ],
    });
    await approveAndSchedule(session, item);
    const original = globalThis.fetch;
    let uploads = 0;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = tweetUrl(input);
      if (url.includes("/2/media/upload")) {
        uploads += 1;
        const response = await original(input, init);
        if (uploads === 1) {
          await env.DB.prepare("UPDATE items SET lease_until = ? WHERE id = ?")
            .bind(Date.now() - 5000, item.id)
            .run();
          await dispatch(env, Date.now());
        }
        return response;
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      await dispatch(env, Date.now());
    } finally {
      globalThis.fetch = original;
    }
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("needs_you");
    expect(saved.needs_reason).toBe("unknown");
    expect(saved.segments[0]?.x_post_id).toBeNull();
    expect(uploads).toBe(1);
    expect(xstate.tweets).toEqual([]);
    await env.DB.prepare("UPDATE items SET lease_until = ? WHERE id = ?")
      .bind(Date.now() + 60_000, item.id)
      .run();
    const early = await send(session, `/api/items/${item.id}/retry`, "POST", {
      position: 0,
      confirm: true,
    });
    expect(early.status).toBe(409);
    expect(await early.text()).toContain(
      "Wait until the last attempt has finished, then check X.",
    );
    const history = await (await send(session, "/history", "GET")).text();
    expect(history).toContain("Check X before you send it again.");
    expect(history).toContain("Post link");
    expect(history).toContain("It posted (paste its link)");
    expect(history).not.toContain("It posted. Paste its link.");
    expect(history).not.toContain(
      "Wait until the last attempt has finished, then check X.",
    );
    expect(xstate.tweets).toEqual([]);
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect(xstate.tweets).toEqual([]);
  });

  it("keeps the post id when the lease is swept during the tweet", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Lost" }],
    });
    await approveAndSchedule(session, item);
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const response = await original(input, init);
      if (tweetUrl(input).includes("/2/tweets")) {
        await env.DB.prepare("UPDATE items SET lease_until = ? WHERE id = ?")
          .bind(Date.now() - 5000, item.id)
          .run();
        await dispatch(env, Date.now());
      }
      return response;
    }) as typeof fetch;
    try {
      await dispatch(env, Date.now());
    } finally {
      globalThis.fetch = original;
    }
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("posted");
    expect(saved.segments[0]?.x_post_id).toBe("1000");
    expect(xstate.tweets).toHaveLength(1);
    const again = await send(session, `/api/items/${item.id}/retry`, "POST", {
      position: 0,
      confirm: true,
    });
    expect(again.status).toBe(409);
    expect(xstate.tweets).toHaveLength(1);
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect(xstate.tweets).toHaveLength(1);
  });

  it("lets two crons post each segment at most once", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "thread",
      segments: [{ text: "A" }, { text: "B" }],
    });
    await approveAndSchedule(session, item);
    const now = Date.now();
    const [left, right] = await Promise.all([
      dispatch(env, now),
      dispatch(env, now),
    ]);
    expect(left.posted + right.posted).toBe(1);
    expect(xstate.tweets).toHaveLength(1);
    const again = await Promise.all([
      dispatch(env, now + 1),
      dispatch(env, now + 1),
    ]);
    expect(again[0].posted + again[1].posted).toBe(1);
    expect(xstate.tweets.map((tweet) => tweet.text)).toEqual(["A", "B"]);
    expect((await readItem(session, item.id)).status).toBe("posted");
  });

  it("resumes segment 2 after a 400 and after a 402", async () => {
    const session = await asUser();
    await connectX();
    for (const statusCode of [400, 402]) {
      resetX();
      const item = await createItem(session, {
        kind: "thread",
        segments: [
          { text: `S1-${statusCode}` },
          { text: `S2-${statusCode}` },
          { text: `S3-${statusCode}` },
        ],
      });
      await approveAndSchedule(session, item);
      expect((await dispatch(env, Date.now())).posted).toBe(1);
      xstate.onTweet = () => ({ statusCode, data: "" });
      expect((await dispatch(env, Date.now())).posted).toBe(0);
      const paused = await readItem(session, item.id);
      expect(paused.status).toBe("needs_you");
      expect(paused.needs_reason).toBe("rejected");
      if (statusCode === 402) {
        expect(paused.last_error).toBe("X API credits are empty.");
      }
      expect((await dispatch(env, Date.now())).posted).toBe(0);
      const bare = await send(session, `/api/items/${item.id}/retry`, "POST", {
        position: 1,
      });
      expect(bare.status).toBe(409);
      xstate.onTweet = null;
      const resumed = await send(
        session,
        `/api/items/${item.id}/retry`,
        "POST",
        {
          confirm: true,
          position: 1,
        },
      );
      expect(resumed.status).toBe(200);
      expect((await dispatch(env, Date.now())).posted).toBe(1);
      const mid = await readItem(session, item.id);
      expect(mid.segments[1]?.x_post_id).toBeTruthy();
      expect(mid.segments[2]?.x_post_id).toBeNull();
      expect(mid.status).toBe("scheduled");
      expect((await dispatch(env, Date.now())).posted).toBe(1);
      expect((await readItem(session, item.id)).status).toBe("posted");
    }
  });

  it("counts segments toward the daily cap", async () => {
    const session = await asUser();
    await connectX();
    const previous = env.MAX_DAILY_POSTS;
    env.MAX_DAILY_POSTS = "1";
    try {
      const item = await createItem(session, {
        kind: "thread",
        segments: [{ text: "Cap 1" }, { text: "Cap 2" }],
      });
      await approveAndSchedule(session, item);
      expect((await dispatch(env, Date.now())).posted).toBe(1);
      const held = await dispatch(env, Date.now());
      expect(held).toEqual({ posted: 0, skipped: "daily_cap" });
      const saved = await readItem(session, item.id);
      expect(saved.segments[1]?.x_post_id).toBeNull();
      expect(xstate.tweets).toHaveLength(1);
    } finally {
      env.MAX_DAILY_POSTS = previous;
    }
  });

  it("refuses a note while an attempt is unresolved, then accepts a link", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Ambiguous line" }],
    });
    await approveAndSchedule(session, item);
    xstate.dropTweet = 0;
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    const patched = await send(session, `/api/items/${item.id}`, "PATCH", {
      kind: "post",
      notes: "Looked at the profile",
      segments: [{ text: "Ambiguous line" }],
    });
    expect(patched.status).toBe(409);
    const open = await env.DB.prepare(
      "SELECT id FROM post_attempts WHERE item_id = ? AND outcome IS NULL",
    )
      .bind(item.id)
      .all();
    expect(open.results?.length).toBe(1);
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect(xstate.tweets).toHaveLength(1);
    const marked = await send(
      session,
      `/api/items/${item.id}/mark-link`,
      "POST",
      { status_url: "https://x.com/exampleuser/status/1000" },
    );
    expect(marked.status).toBe(200);
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("posted");
    expect(saved.segments[0]?.x_post_id).toBe("1000");
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    expect(xstate.tweets).toHaveLength(1);
  });

  it("rejects a status link when X says a different account wrote it", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Check the author" }],
    });
    await approveAndSchedule(session, item);
    xstate.dropTweet = 0;
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    xstate.postAuthors["1000"] = "111";
    const marked = await send(
      session,
      `/api/items/${item.id}/mark-link`,
      "POST",
      {
        status_url: "https://x.com/exampleuser/status/1000",
      },
    );
    expect(marked.status).toBe(422);
    const saved = await readItem(session, item.id);
    expect(saved.status).toBe("needs_you");
    expect(saved.segments[0]?.x_post_id).toBeNull();
  });

  it("posts a restored item that still has a rejected attempt", async () => {
    const session = await asUser();
    await connectX();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Rejected then restored" }],
    });
    await approveAndSchedule(session, item);
    xstate.onTweet = () => ({ statusCode: 400, data: "" });
    expect((await dispatch(env, Date.now())).posted).toBe(0);
    xstate.onTweet = null;
    expect(
      (await send(session, `/api/items/${item.id}/archive`, "POST")).status,
    ).toBe(200);
    expect(
      (await postForm(session, `/items/${item.id}/restore`, {})).status,
    ).toBe(303);
    const again = await readItem(session, item.id);
    expect(again.status).toBe("draft");
    await approveAndSchedule(session, again);
    expect((await dispatch(env, Date.now())).posted).toBe(1);
    expect((await readItem(session, item.id)).status).toBe("posted");
  });

  it("keeps an already posted segment on its original day after a zone change", async () => {
    const session = await asUser();
    await connectX();
    const previous = env.MAX_DAILY_POSTS;
    env.MAX_DAILY_POSTS = "1";
    const now = Date.parse("2026-10-22T03:30:00.000Z");
    try {
      await env.DB.prepare(
        "UPDATE app_settings SET time_zone = 'America/New_York' WHERE id = 1",
      ).run();
      const first = await createItem(session, {
        kind: "post",
        segments: [{ text: "Posted in New York" }],
      });
      await approveAndSchedule(session, first, now - 1000);
      expect((await dispatch(env, now)).posted).toBe(1);
      const day = await env.DB.prepare(
        "SELECT posted_day FROM segments WHERE item_id = ?",
      )
        .bind(first.id)
        .first<{ posted_day: string }>();
      expect(day?.posted_day).toBe("2026-10-21");
      await env.DB.prepare(
        "UPDATE app_settings SET time_zone = 'Asia/Tokyo' WHERE id = 1",
      ).run();
      const second = await createItem(session, {
        kind: "post",
        segments: [{ text: "Posted in Tokyo" }],
      });
      await approveAndSchedule(session, second, now - 1000);
      expect((await dispatch(env, now)).posted).toBe(0);
      const still = await env.DB.prepare(
        "SELECT posted_day FROM segments WHERE item_id = ?",
      )
        .bind(first.id)
        .first<{ posted_day: string }>();
      expect(still?.posted_day).toBe("2026-10-21");
      expect(xstate.tweets.map((tweet) => tweet.text)).toEqual([
        "Posted in New York",
      ]);
    } finally {
      env.MAX_DAILY_POSTS = previous;
    }
  });
});

describe("intake callers", () => {
  it("keeps drafts on the token id, including the reserved env bot", async () => {
    const tokenA = await createNamedToken(env, "desk-a", Date.now());
    const tokenB = await createNamedToken(env, "desk-b", Date.now());
    const rowA = await env.DB.prepare(
      "SELECT id FROM intake_tokens WHERE name = ?",
    )
      .bind("desk-a")
      .first<{ id: string }>();
    expect(rowA?.id).toBeTruthy();
    expect(rowA?.id).not.toBe("env:intake");
    await expect(createNamedToken(env, "x-drafts", Date.now())).rejects.toThrow(
      /already in use/,
    );
    const headersA = await intakeHeaders(tokenA, "intake-audience");
    const headersB = await intakeHeaders(tokenB, "intake-audience");
    const envHeaders = await intakeHeaders(
      "test-intake-token",
      "intake-audience",
    );
    const draft = await SELF.fetch(`${ORIGIN}/api/intake/drafts`, {
      method: "POST",
      headers: { ...headersA, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "post",
        source_ref: "caller-a",
        segments: [{ text: "From A" }],
      }),
    });
    expect(draft.status).toBe(201);
    const item = (
      (await draft.json()) as { item: { id: string; source: string } }
    ).item;
    expect(item.source).toBe(rowA?.id);
    const deniedB = await SELF.fetch(`${ORIGIN}/api/intake/drafts/${item.id}`, {
      headers: headersB,
    });
    expect(deniedB.status).toBe(404);
    const deniedEnv = await SELF.fetch(
      `${ORIGIN}/api/intake/drafts/${item.id}`,
      { headers: envHeaders },
    );
    expect(deniedEnv.status).toBe(404);
    const allowed = await SELF.fetch(`${ORIGIN}/api/intake/drafts/${item.id}`, {
      headers: headersA,
    });
    expect(allowed.status).toBe(200);
    const remote = await SELF.fetch(`${ORIGIN}/api/intake/drafts`, {
      method: "POST",
      headers: { ...envHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "post",
        segments: [
          {
            text: "No url",
            media: [
              {
                alt_text: "hidden",
                url: "https://127.0.0.1.nip.io/secret.png",
              },
            ],
          },
        ],
      }),
    });
    expect(remote.status).toBe(422);
    expect(xstate.paths.some((path) => path.includes("nip.io"))).toBe(false);
    await expect(
      env.DB.prepare(
        "INSERT INTO intake_tokens (id, name, token_sha256, created_at) VALUES ('env:intake', 'other', 'abc', 1)",
      ).run(),
    ).rejects.toThrow();
  });
});

describe("token refresh lock", () => {
  it("waits out the refresh lease before touching the token", async () => {
    await connectX(Date.now() - 60_000);
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE oauth_account SET lease_id = ?, lease_until = ? WHERE id = 1",
    )
      .bind("held-lease", now + 30_000)
      .run();
    const pending = accessTokenForPosting(env, now);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const access = await encryptString(env.TOKEN_ENC_KEY, "winner-access");
    await env.DB.prepare(
      `UPDATE oauth_account
       SET lease_id = NULL, lease_until = NULL, access_token_enc = ?, iv_access = ?, expires_at = ?
       WHERE id = 1`,
    )
      .bind(access.cipher, access.iv, now + 2 * 60 * 60 * 1000)
      .run();
    expect(await pending).toBe("winner-access");
    expect(xstate.paths.filter((path) => path === "/2/oauth2/token")).toEqual(
      [],
    );
  });

  it("revokes the new refresh token when users/me fails", async () => {
    await connectX(Date.now() - 60_000);
    xstate.meStatus = 500;
    expect(await accessTokenForPosting(env, Date.now())).toBeNull();
    expect(xstate.paths).toContain("/2/oauth2/revoke");
    const row = await env.DB.prepare(
      "SELECT needs_reconnect FROM oauth_account WHERE id = 1",
    ).first<{ needs_reconnect: number }>();
    expect(row?.needs_reconnect).toBe(1);
  });

  it("gives the loser the new token instead of reconnect", async () => {
    await connectX(Date.now() - 60_000);
    const now = Date.now();
    const [left, right] = await Promise.all([
      accessTokenForPosting(env, now),
      accessTokenForPosting(env, now),
    ]);
    expect(left).toBe("refreshed-access-token");
    expect(right).toBe("refreshed-access-token");
    expect(
      xstate.paths.filter((path) => path === "/2/oauth2/token"),
    ).toHaveLength(1);
    const row = await env.DB.prepare(
      "SELECT needs_reconnect FROM oauth_account WHERE id = 1",
    ).first<{ needs_reconnect: number }>();
    expect(row?.needs_reconnect).toBe(0);
  });
});

describe("schema", () => {
  it("rejects a bad review stage, a dropped status, and a dangling image", async () => {
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Schema" }],
    });
    await expect(
      env.DB.prepare("UPDATE items SET review_stage = 'editor' WHERE id = ?")
        .bind(item.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE items SET status = 'failed' WHERE id = ?")
        .bind(item.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO media (id, item_id, segment_id, position, r2_key, mime, bytes, alt_text) VALUES ('m-missing', ?, 'missing-segment', 0, 'media/x', 'image/png', 1, 'alt')",
      )
        .bind(item.id)
        .run(),
    ).rejects.toThrow();
  });
});
