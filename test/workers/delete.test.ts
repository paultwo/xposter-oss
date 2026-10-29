import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
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

async function rowCount(sql: string, id: string): Promise<number> {
  const row = await env.DB.prepare(sql).bind(id).first<{ n: number }>();
  return row?.n ?? 0;
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

  it("refuses an archived item that may have posted, and offers no Delete for it", async () => {
    await connectX();
    const session = await asUser();
    const open = await createItem(session, {
      kind: "post",
      segments: [{ text: "Archived with an open attempt" }],
    });
    const segment = await env.DB.prepare(
      "SELECT id FROM segments WHERE item_id = ?",
    )
      .bind(open.id)
      .first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO post_attempts (id, segment_id, item_id, lease_id, started_at, outcome) VALUES ('att-open', ?, ?, 'lease-x', 1, NULL)",
    )
      .bind(segment?.id ?? "", open.id)
      .run();
    await env.DB.prepare("UPDATE items SET status = 'archived' WHERE id = ?")
      .bind(open.id)
      .run();
    const refused = await send(session, `/api/items/${open.id}`, "DELETE", {
      confirm: true,
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("can't be deleted here");
    expect(
      await rowCount("SELECT COUNT(*) AS n FROM items WHERE id = ?", open.id),
    ).toBe(1);

    const needs = await createItem(session, {
      kind: "post",
      segments: [{ text: "Archived after needs-you" }],
    });
    await env.DB.prepare(
      "UPDATE items SET status = 'archived', needs_reason = 'unknown' WHERE id = ?",
    )
      .bind(needs.id)
      .run();
    const page = await send(session, "/archived", "GET");
    const html = await page.text();
    expect(html).toContain("Archived after needs-you");
    expect(html).not.toContain(`delete-${needs.id}`);
    const again = await send(session, `/api/items/${needs.id}`, "DELETE", {
      confirm: true,
    });
    expect(again.status).toBe(409);
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
