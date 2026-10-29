import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteItem } from "../../src/items/delete";
import { dispatch } from "../../src/posting/dispatch";
import {
  approveAndSchedule,
  asUser,
  connectX,
  createItem,
  PNG,
  postForm,
  readItem,
  resetPostingGate,
  send,
} from "./helpers";
import { resetX, xstate } from "./mock-x";

beforeEach(async () => {
  resetX();
  await resetPostingGate();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function rowCount(sql: string, id: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(id).first<{ n: number }>();
  return row?.n ?? 0;
}

async function expectNothingLeft(id: string): Promise<void> {
  for (const table of ["items", "segments", "post_attempts", "media"]) {
    const column = table === "items" ? "id" : "item_id";
    expect(
      await rowCount(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`,
        id,
      ),
      table,
    ).toBe(0);
  }
  const orphans = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM daily_slots WHERE segment_id NOT IN (SELECT id FROM segments)",
  ).first<{ n: number }>();
  expect(orphans?.n ?? 0, "daily_slots").toBe(0);
}

describe("delete", () => {
  it("refuses without confirm and deletes a draft, its segments, and its media with confirm", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "thread",
      segments: [
        {
          text: "First",
          media: [{ alt_text: "A chart", data_base64: PNG, mime: "image/png" }],
        },
        { text: "Second" },
      ],
    });
    const keys = await env.DB.prepare(
      "SELECT r2_key FROM media WHERE item_id = ?",
    )
      .bind(item.id)
      .all<{ r2_key: string }>();
    expect(keys.results.length).toBe(1);
    const key = keys.results[0]?.r2_key ?? "";
    expect(await env.MEDIA.head(key)).not.toBeNull();

    const unconfirmed = await send(session, `/api/items/${item.id}`, "DELETE");
    expect(unconfirmed.status).toBe(409);
    const wrong = await send(session, `/api/items/${item.id}`, "DELETE", {
      confirm: "yes",
    });
    expect(wrong.status).toBe(409);
    expect((await readItem(session, item.id)).status).toBe("draft");

    const deleted = await send(session, `/api/items/${item.id}`, "DELETE", {
      confirm: true,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      deleted: true,
      id: item.id,
      was: "draft",
    });
    const gone = await send(session, `/api/items/${item.id}`, "GET");
    expect(gone.status).toBe(404);
    expect(
      await rowCount(
        "SELECT COUNT(*) AS n FROM segments WHERE item_id = ?",
        item.id,
      ),
    ).toBe(0);
    expect(
      await rowCount(
        "SELECT COUNT(*) AS n FROM media WHERE item_id = ?",
        item.id,
      ),
    ).toBe(0);
    expect(await env.MEDIA.head(key)).toBeNull();
    const audit = await env.DB.prepare(
      "SELECT item_id, action, from_status, detail_json FROM audit_log WHERE action = 'delete' AND json_extract(detail_json, '$.item_id') = ?",
    )
      .bind(item.id)
      .first<{ item_id: string | null; action: string; from_status: string }>();
    expect(audit?.item_id).toBeNull();
    expect(audit?.from_status).toBe("draft");

    const again = await send(session, `/api/items/${item.id}`, "DELETE", {
      confirm: true,
    });
    expect(again.status).toBe(404);
  });

  it("deletes a due scheduled post so the dispatcher never sends it", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Never send this" }],
    });
    await approveAndSchedule(session, item);
    expect((await readItem(session, item.id)).status).toBe("scheduled");
    const deleted = await send(session, `/api/items/${item.id}`, "DELETE", {
      confirm: true,
    });
    expect(deleted.status).toBe(200);
    await dispatch(env, Date.now());
    expect(xstate.tweets).toEqual([]);
    expect(
      await rowCount("SELECT COUNT(*) AS n FROM items WHERE id = ?", item.id),
    ).toBe(0);
  });

  it("refuses a delete that arrives after the cron claimed the post, and the post goes out once", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Claimed before the delete" }],
    });
    await approveAndSchedule(session, item);
    // The tweet call only happens after the claim committed, so a delete
    // sent from inside it always lands on a claimed row.
    let racing: Promise<Response> | null = null;
    xstate.onTweet = (index) => {
      racing = send(session, `/api/items/${item.id}`, "DELETE", {
        confirm: true,
      });
      return {
        statusCode: 201,
        data: JSON.stringify({ data: { id: String(9100 + index), text: "" } }),
        responseOptions: { headers: { "content-type": "application/json" } },
      };
    };
    const result = await dispatch(env, Date.now());
    expect(result.posted).toBe(1);
    expect(racing).not.toBeNull();
    const refused = await (racing as unknown as Promise<Response>);
    expect(refused.status).toBe(409);
    expect(xstate.tweets.map((tweet) => tweet.text)).toEqual([
      "Claimed before the delete",
    ]);
    expect((await readItem(session, item.id)).status).toBe("posted");
    expect(
      await rowCount(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'delete' AND json_extract(detail_json, '$.item_id') = ?",
        item.id,
      ),
    ).toBe(0);
  });

  it("a delete and a dispatch at the same moment end with exactly one outcome", async () => {
    await connectX();
    const session = await asUser();
    for (let round = 0; round < 5; round++) {
      resetX();
      const text = `Race round ${round}`;
      const item = await createItem(session, {
        kind: "post",
        segments: [{ text }],
      });
      await approveAndSchedule(session, item);
      const [result, deleted] = await Promise.all([
        dispatch(env, Date.now()),
        send(session, `/api/items/${item.id}`, "DELETE", { confirm: true }),
      ]);
      const sent = xstate.tweets.filter((tweet) => tweet.text === text).length;
      const remaining = await rowCount(
        "SELECT COUNT(*) AS n FROM items WHERE id = ?",
        item.id,
      );
      if (deleted.status === 200) {
        expect(sent).toBe(0);
        expect(remaining).toBe(0);
        expect(result.posted).toBe(0);
      } else {
        expect(deleted.status).toBe(409);
        expect(sent).toBe(1);
        expect(remaining).toBe(1);
        expect((await readItem(session, item.id)).status).toBe("posted");
      }
    }
  });

  it("still deletes the item when the R2 blob delete fails, and logs it without the key", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [
        {
          text: "Has an image",
          media: [{ alt_text: "A chart", data_base64: PNG, mime: "image/png" }],
        },
      ],
    });
    const key =
      (
        await env.DB.prepare("SELECT r2_key FROM media WHERE item_id = ?")
          .bind(item.id)
          .first<{ r2_key: string }>()
      )?.r2_key ?? "";
    expect(key).not.toBe("");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const failing = {
      ...env,
      MEDIA: {
        delete: async () => {
          throw new Error("R2 is down");
        },
      } as unknown as R2Bucket,
    };
    const deleted = await deleteItem(
      failing,
      item.id,
      "you@example.com",
      Date.now(),
    );
    expect(deleted).toEqual({ id: item.id, status: "draft" });
    expect(
      await rowCount("SELECT COUNT(*) AS n FROM items WHERE id = ?", item.id),
    ).toBe(0);
    const failures = lines.filter((line) =>
      line.includes('"media_delete_failed"'),
    );
    expect(failures).toHaveLength(1);
    expect(JSON.parse(failures[0] ?? "{}")).toEqual({
      level: "error",
      event: "media_delete_failed",
      item_id: item.id,
      reason: "Error",
    });
    expect(failures[0]).not.toContain(key);
    expect(await env.MEDIA.head(key)).not.toBeNull();
  });

  it("deletes an approved draft and an archived draft", async () => {
    await connectX();
    const session = await asUser();
    const approved = await createItem(session, {
      kind: "post",
      segments: [{ text: "Approved only" }],
    });
    const ok = await send(
      session,
      `/api/items/${approved.id}/approve`,
      "POST",
      {
        expected_hash: approved.content_hash,
      },
    );
    expect(ok.status).toBe(200);
    const archived = await createItem(session, {
      kind: "post",
      segments: [{ text: "Archived one" }],
    });
    const arch = await send(
      session,
      `/api/items/${archived.id}/archive`,
      "POST",
    );
    expect(arch.status).toBe(200);
    for (const id of [approved.id, archived.id]) {
      const res = await send(session, `/api/items/${id}`, "DELETE", {
        confirm: true,
      });
      expect(res.status).toBe(200);
    }
  });

  it("deletes a failed post, and neither the cron nor Send again can bring it back", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Rejected by X" }],
    });
    await approveAndSchedule(session, item);
    xstate.onTweet = () => ({ statusCode: 400, data: "" });
    await dispatch(env, Date.now());
    xstate.onTweet = null;
    const failed = await readItem(session, item.id);
    expect(failed.status).toBe("needs_you");
    expect(failed.needs_reason).toBe("rejected");
    expect(xstate.tweets).toHaveLength(1);

    const dashboard = await SELFGet(session, "/?status=needs_you");
    expect(dashboard).toContain(`data-dialog="delete-${item.id}"`);
    expect(dashboard).toContain("Delete this failed post?");
    expect(dashboard).toContain("It will not be sent again.");
    const history = await SELFGet(session, "/history");
    expect(history).toContain(`data-dialog="delete-${item.id}"`);

    const done = await postForm(session, `/items/${item.id}/delete`, {
      confirm: "yes",
      back: "history",
    });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/history?notice=deleted");
    await expectNothingLeft(item.id);
    const retry = await send(session, `/api/items/${item.id}/retry`, "POST", {
      position: 0,
      confirm: true,
    });
    expect(retry.status).toBe(404);
    await dispatch(env, Date.now());
    await dispatch(env, Date.now() + 120_000);
    expect(xstate.tweets).toHaveLength(1);
    const audit = await env.DB.prepare(
      "SELECT from_status, detail_json FROM audit_log WHERE action = 'delete' AND json_extract(detail_json, '$.item_id') = ?",
    )
      .bind(item.id)
      .first<{ from_status: string; detail_json: string }>();
    expect(audit?.from_status).toBe("needs_you");
    expect(JSON.parse(audit?.detail_json ?? "{}").needs_reason).toBe(
      "rejected",
    );
  });

  it("deletes an unconfirmed post once its last attempt has finished, and frees its slot and attempt", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "X answered 500" }],
    });
    await approveAndSchedule(session, item);
    xstate.dropTweet = 0;
    await dispatch(env, Date.now());
    xstate.dropTweet = null;
    const unknown = await readItem(session, item.id);
    expect(unknown.status).toBe("needs_you");
    expect(unknown.needs_reason).toBe("unknown");
    expect(
      await rowCount(
        "SELECT COUNT(*) AS n FROM post_attempts WHERE item_id = ? AND outcome IS NULL",
        item.id,
      ),
    ).toBe(1);
    // A sweep can leave the hold in place; plant one so the delete has to
    // free it.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO daily_slots (id, day_key, segment_id, state, created_at)
       SELECT 'slot-unknown', '2026-01-01', id, 'held', ? FROM segments WHERE item_id = ?`,
    )
      .bind(Date.now(), item.id)
      .run();
    expect(
      await rowCount(
        "SELECT COUNT(*) AS n FROM daily_slots WHERE state = 'held' AND segment_id IN (SELECT id FROM segments WHERE item_id = ?)",
        item.id,
      ),
    ).toBe(1);

    await env.DB.prepare("UPDATE items SET lease_until = ? WHERE id = ?")
      .bind(Date.now() + 60_000, item.id)
      .run();
    const early = await send(session, `/api/items/${item.id}`, "DELETE", {
      confirm: true,
    });
    expect(early.status).toBe(409);
    expect(await early.text()).toContain(
      "Wait until the last attempt has finished, then check X.",
    );
    await env.DB.prepare("UPDATE items SET lease_until = ? WHERE id = ?")
      .bind(Date.now() - 60_000, item.id)
      .run();
    const page = await SELFGet(session, "/history");
    expect(page).toContain("Delete this unconfirmed post?");
    expect(page).toContain("does not remove anything from X");

    const deleted = await send(session, `/api/items/${item.id}`, "DELETE", {
      confirm: true,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      deleted: true,
      id: item.id,
      was: "needs_you",
    });
    await expectNothingLeft(item.id);
    expect(
      await rowCount(
        "SELECT COUNT(*) AS n FROM post_attempts WHERE item_id = ?",
        item.id,
      ),
    ).toBe(0);
    const retry = await send(session, `/api/items/${item.id}/retry`, "POST", {
      position: 0,
      confirm: true,
    });
    expect(retry.status).toBe(404);
    await dispatch(env, Date.now() + 120_000);
    expect(xstate.tweets).toHaveLength(1);
  });

  it("deletes an archived item that was once needs-you", async () => {
    await connectX();
    const session = await asUser();
    const needs = await createItem(session, {
      kind: "post",
      segments: [{ text: "Archived after needs-you" }],
    });
    await env.DB.prepare(
      "UPDATE items SET status = 'archived', needs_reason = 'unknown' WHERE id = ?",
    )
      .bind(needs.id)
      .run();
    const html = await SELFGet(session, "/archived");
    expect(html).toContain(`delete-${needs.id}`);
    const deleted = await send(session, `/api/items/${needs.id}`, "DELETE", {
      confirm: true,
    });
    expect(deleted.status).toBe(200);
  });

  it("refuses a needs-you thread whose first post is on X, and offers no Delete", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "thread",
      segments: [{ text: "Live part" }, { text: "Rejected part" }],
    });
    await approveAndSchedule(session, item);
    expect((await dispatch(env, Date.now())).posted).toBe(1);
    xstate.onTweet = () => ({ statusCode: 400, data: "" });
    await dispatch(env, Date.now());
    xstate.onTweet = null;
    expect((await readItem(session, item.id)).status).toBe("needs_you");
    const history = await SELFGet(session, "/history");
    expect(history).not.toContain(`data-dialog="delete-${item.id}"`);
    const refused = await send(session, `/api/items/${item.id}`, "DELETE", {
      confirm: true,
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("has any part on X");
    expect(
      await rowCount("SELECT COUNT(*) AS n FROM items WHERE id = ?", item.id),
    ).toBe(1);
  });

  it("a delete that arrives after Send again and the cron claim is refused, and the post goes out once", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Sent again" }],
    });
    await approveAndSchedule(session, item);
    xstate.onTweet = () => ({ statusCode: 400, data: "" });
    await dispatch(env, Date.now());
    const retry = await send(session, `/api/items/${item.id}/retry`, "POST", {
      position: 0,
      confirm: true,
    });
    expect(retry.status).toBe(200);
    let racing: Promise<Response> | null = null;
    xstate.onTweet = (index) => {
      racing = send(session, `/api/items/${item.id}`, "DELETE", {
        confirm: true,
      });
      return {
        statusCode: 201,
        data: JSON.stringify({ data: { id: String(9200 + index), text: "" } }),
        responseOptions: { headers: { "content-type": "application/json" } },
      };
    };
    expect((await dispatch(env, Date.now())).posted).toBe(1);
    const refused = await (racing as unknown as Promise<Response>);
    expect(refused.status).toBe(409);
    expect((await readItem(session, item.id)).status).toBe("posted");
    expect(xstate.tweets.map((tweet) => tweet.text)).toEqual([
      "Sent again",
      "Sent again",
    ]);
  });

  it("Send again and a delete at the same moment end with exactly one outcome", async () => {
    await connectX();
    const session = await asUser();
    for (let round = 0; round < 5; round++) {
      resetX();
      const text = `Retry race ${round}`;
      const item = await createItem(session, {
        kind: "post",
        segments: [{ text }],
      });
      await approveAndSchedule(session, item);
      xstate.onTweet = () => ({ statusCode: 400, data: "" });
      await dispatch(env, Date.now());
      xstate.onTweet = null;
      const [retry, deleted] = await Promise.all([
        send(session, `/api/items/${item.id}/retry`, "POST", {
          position: 0,
          confirm: true,
        }),
        send(session, `/api/items/${item.id}`, "DELETE", { confirm: true }),
      ]);
      await dispatch(env, Date.now() + 1000);
      const sends = xstate.tweets.filter((tweet) => tweet.text === text);
      // A retry that lands first leaves a scheduled row, which is still
      // deletable, so a 200 retry with a 200 delete is a clean outcome too.
      if (deleted.status === 200) {
        expect([200, 404, 409]).toContain(retry.status);
        await expectNothingLeft(item.id);
        expect(sends).toHaveLength(1);
      } else {
        expect(deleted.status).toBe(409);
        expect(retry.status).toBe(200);
        expect(sends).toHaveLength(2);
        expect((await readItem(session, item.id)).status).toBe("posted");
      }
    }
  });

  it("refuses to delete a posted item or one that is posting", async () => {
    await connectX();
    const session = await asUser();
    const posted = await createItem(session, {
      kind: "post",
      segments: [{ text: "This one posts" }],
    });
    await approveAndSchedule(session, posted);
    await dispatch(env, Date.now());
    expect((await readItem(session, posted.id)).status).toBe("posted");
    const refused = await send(session, `/api/items/${posted.id}`, "DELETE", {
      confirm: true,
    });
    expect(refused.status).toBe(409);
    expect((await readItem(session, posted.id)).status).toBe("posted");

    const inFlight = await createItem(session, {
      kind: "post",
      segments: [{ text: "Claimed" }],
    });
    await approveAndSchedule(session, inFlight, Date.now() + 3_600_000);
    await env.DB.prepare(
      "UPDATE items SET status = 'posting', lease_id = 'lease-x', lease_until = ? WHERE id = ?",
    )
      .bind(Date.now() + 60_000, inFlight.id)
      .run();
    const busy = await send(session, `/api/items/${inFlight.id}`, "DELETE", {
      confirm: true,
    });
    expect(busy.status).toBe(409);
    expect(
      await rowCount(
        "SELECT COUNT(*) AS n FROM items WHERE id = ?",
        inFlight.id,
      ),
    ).toBe(1);
  });

  it("refuses when a segment already has an X post id, even if the status says scheduled", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "thread",
      segments: [{ text: "One" }, { text: "Two" }],
    });
    await approveAndSchedule(session, item, Date.now() + 3_600_000);
    await env.DB.prepare(
      "UPDATE segments SET x_post_id = '777', posted_at = ? WHERE item_id = ? AND position = 0",
    )
      .bind(Date.now(), item.id)
      .run();
    const refused = await send(session, `/api/items/${item.id}`, "DELETE", {
      confirm: true,
    });
    expect(refused.status).toBe(409);
    expect(
      await rowCount("SELECT COUNT(*) AS n FROM items WHERE id = ?", item.id),
    ).toBe(1);
  });

  it("shows a confirm dialog and deletes from the queue form only with confirm", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Queued for later" }],
    });
    await approveAndSchedule(session, item, Date.now() + 3_600_000);
    const queue = await SELFGet(session, "/queue");
    expect(queue).toContain(`data-dialog="delete-${item.id}"`);
    expect(queue).toContain("Delete this scheduled post?");
    expect(queue).toContain("will not post to X");
    const review = await SELFGet(session, `/items/${item.id}/review`);
    expect(review).toContain(`action="/items/${item.id}/delete"`);

    const noConfirm = await postForm(session, `/items/${item.id}/delete`, {
      back: "queue",
    });
    expect(noConfirm.status).toBe(409);
    expect((await readItem(session, item.id)).status).toBe("scheduled");

    const done = await postForm(session, `/items/${item.id}/delete`, {
      confirm: "yes",
      back: "queue",
    });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/queue?notice=deleted");
    expect(
      await rowCount("SELECT COUNT(*) AS n FROM items WHERE id = ?", item.id),
    ).toBe(0);
  });

  it("does not offer Delete for a posted item", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Already out" }],
    });
    await approveAndSchedule(session, item);
    await dispatch(env, Date.now());
    const history = await SELFGet(session, "/history");
    expect(history).not.toContain(`data-dialog="delete-${item.id}"`);
    const dashboard = await SELFGet(session, "/?status=all");
    expect(dashboard).not.toContain(`data-dialog="delete-${item.id}"`);
  });
});

async function SELFGet(
  session: Awaited<ReturnType<typeof asUser>>,
  path: string,
): Promise<string> {
  const response = await send(session, path, "GET");
  expect(response.status).toBe(200);
  return response.text();
}
