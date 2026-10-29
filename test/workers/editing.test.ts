import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { updateDraft } from "../../src/items/service";
import {
  approveAndSchedule,
  asUser,
  auth,
  connectX,
  createItem,
  ORIGIN,
  PNG,
  postForm,
  readItem,
  send,
} from "./helpers";
import { resetX } from "./mock-x";

beforeEach(() => {
  resetX();
});

describe("editing safety", () => {
  it("refuses an edit when the cron claims the item between read and write", async () => {
    await connectX();
    const session = await asUser();
    const item = await createItem(session, {
      kind: "thread",
      segments: [{ text: "Claimed one" }, { text: "Claimed two" }],
    });
    await approveAndSchedule(session, item);
    const db = env.DB;
    const racing = {
      ...env,
      DB: new Proxy(db, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              await target
                .prepare(
                  "UPDATE items SET status = 'posting', lease_id = 'cron', lease_until = ?, updated_at = ? WHERE id = ?",
                )
                .bind(Date.now() + 120_000, Date.now() + 1, item.id)
                .run();
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as Env;
    await expect(
      updateDraft(
        racing,
        item.id,
        {
          kind: "thread",
          title: null,
          notes: null,
          reviewedBy: null,
          segments: [
            { text: "Swapped one", media: [] },
            { text: "Swapped two", media: [] },
          ],
        },
        "you@example.com",
        Date.now(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const after = await readItem(session, item.id);
    expect(after.status).toBe("posting");
    expect(after.content_hash).toBe(item.content_hash);
    expect(after.segments.map((segment) => segment.text)).toEqual([
      "Claimed one",
      "Claimed two",
    ]);
  });

  it("rejects images on an article, since publish sends text only", async () => {
    const session = await asUser();
    const response = await send(session, "/api/items", "POST", {
      kind: "article",
      title: "With a picture",
      segments: [
        {
          text: "Body",
          media: [{ alt_text: "A chart", data_base64: PNG, mime: "image/png" }],
        },
      ],
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/Articles post text only/);
  });

  it("keeps later segments when a middle one was removed in the browser", async () => {
    const session = await asUser();
    const response = await postForm(session, "/items", {
      kind: "thread",
      segment_count: "2",
      text_0: "Kept first",
      text_2: "Kept third",
    });
    expect(response.status).toBe(303);
    const id =
      (response.headers.get("location") ?? "").split("/")[2]?.split("?")[0] ??
      "";
    const saved = await readItem(session, id);
    expect(saved.segments.map((segment) => segment.text)).toEqual([
      "Kept first",
      "Kept third",
    ]);
  });

  it("splits the text on screen, including edits that were not saved yet", async () => {
    const session = await asUser();
    const item = await createItem(session, {
      kind: "post",
      segments: [{ text: "Short saved text" }],
    });
    const unsaved = Array.from(
      { length: 80 },
      (_, index) => `word${index}`,
    ).join(" ");
    const response = await postForm(session, `/items/${item.id}/split`, {
      kind: "post",
      segment_count: "1",
      text_0: unsaved,
    });
    expect(response.status).toBe(303);
    const split = await readItem(session, item.id);
    expect(split.segments.length).toBeGreaterThan(1);
    expect(split.segments.map((segment) => segment.text).join(" ")).toBe(
      unsaved,
    );
  });

  it("sends the OAuth state cookie on X's cross-site redirect back", async () => {
    const session = await asUser();
    const response = await SELF.fetch(`${ORIGIN}/oauth/x/start`, {
      headers: auth(session),
      redirect: "manual",
    });
    const cookie = (response.headers.getSetCookie?.() ?? []).find((row) =>
      row.startsWith("xp_oauth="),
    );
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/HttpOnly/i);
  });
});
