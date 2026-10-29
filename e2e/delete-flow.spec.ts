import { expect, test, type Page } from "@playwright/test";
import {
  apiDelete,
  apiStatus,
  attemptedTexts,
  csrf,
  deleteFromList,
  deleteWithKeyboard,
  expectGone,
  postedTexts,
  resetMockX,
  saveDraft,
  setMockX,
  shot,
  signIn,
} from "./delete-kit";
import { upcomingSlot } from "./slot";

const run = Date.now().toString(36);
const REFUSED = "This can't be deleted here. Anything that is posting, or has any part on X, stays.";

async function connect(page: Page): Promise<void> {
  await page.goto("/settings");
  const status = page.locator("#connection-status");
  if ((await status.textContent()) !== "Connected as @exampleuser.") {
    await page.getByRole("link", { name: "Connect X" }).click();
  }
  await expect(status).toHaveText("Connected as @exampleuser.");
}

async function schedule(page: Page, text: string, slot: ReturnType<typeof upcomingSlot>): Promise<string> {
  const id = await saveDraft(page, text);
  await page.getByRole("link", { name: "Review and approve" }).click();
  await page.getByRole("button", { name: "Approve post" }).click();
  await expect(page.getByText("Approved.")).toBeVisible();
  await page.locator("#schedule-date").fill(slot.date);
  await page.locator("#schedule-time").fill(slot.time);
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByText("Scheduled.", { exact: true })).toBeVisible();
  return id;
}

// The dev-only hook runs the same dispatch() the cron handler runs, at a
// chosen clock, so a slot days out can come due now.
async function cronTick(page: Page, jwt: string, now: number): Promise<{ posted: number; skipped: string | null }> {
  const response = await page.request.post("/__dev/dispatch", {
    headers: { "content-type": "application/json", "x-csrf-token": await csrf(page), "cf-access-jwt-assertion": jwt },
    data: { now },
    timeout: 20_000,
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function expectNoDelete(page: Page, text: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    await page.goto(path);
    await expect(page.getByText(text).first()).toBeVisible();
    await expect(page.getByRole("button", { name: `Delete: ${text}` })).toHaveCount(0);
  }
}

async function expectRefused(page: Page, id: string, status: string): Promise<void> {
  const api = await apiDelete(page, id);
  expect(api.status()).toBe(409);
  expect(await api.json()).toMatchObject({ error: { message: REFUSED } });
  const form = await page.request.post(`/items/${id}/delete`, {
    headers: { accept: "text/html" },
    form: { csrf: await csrf(page), confirm: "yes" },
  });
  expect(form.status()).toBe(409);
  expect(await form.text()).toContain("be deleted here. Anything that is posting, or has any part on X, stays.");
  expect(await apiStatus(page, id)).toBe(200);
  const item = (await (await page.request.get(`/api/items/${id}`)).json()) as { item: { status: string } };
  expect(item.item.status).toBe(status);
}

let jwt = "";

test.beforeEach(async ({ page }) => {
  await resetMockX();
  jwt = await signIn(page);
  await connect(page);
});

test("a scheduled post deleted from the queue stays gone and never reaches X when it comes due", async ({ page }) => {
  const slot = upcomingSlot(4, 9, 30);
  const doomed = `Queued post deleted before its slot ${run}.`;
  const control = `Queued post that keeps its slot ${run}.`;
  const doomedId = await schedule(page, doomed, slot);
  await schedule(page, control, slot);

  await page.goto("/queue");
  await expect(page.getByRole("button", { name: `Delete: ${doomed}` })).toHaveCount(1);
  await shot(page, "queue-1-before");
  await deleteFromList(page, doomed, "Delete this scheduled post?");
  await expect(page).toHaveURL(/\/queue\?notice=deleted$/);
  await shot(page, "queue-2-after-delete");
  await page.reload();
  await expect(page.getByRole("button", { name: `Delete: ${doomed}` })).toHaveCount(0);
  await expect(page.getByText(doomed)).toHaveCount(0);
  await expect(page.getByText(control)).toBeVisible();
  await shot(page, "queue-3-after-reload");
  await expectGone(page, doomedId, doomed, ["/queue", "/", "/?status=all"]);

  // Two ticks: the first posts the control, the second would pick up anything
  // still due. The control posting proves the tick ran at the slot. The
  // wrangler scheduled trigger then runs the real cron handler once.
  await cronTick(page, jwt, slot.utc + 1000);
  await cronTick(page, jwt, slot.utc + 1000);
  expect((await page.request.get("/cdn-cgi/local/scheduled")).ok()).toBe(true);
  expect((await attemptedTexts()).filter((text) => text === doomed)).toEqual([]);
  expect((await postedTexts()).filter((text) => text === control)).toEqual([control]);
  await page.goto("/history");
  await expect(page.getByText(control)).toBeVisible();
  await expect(page.getByText(doomed)).toHaveCount(0);
  await shot(page, "queue-4-history-after-tick");
});

test("a posted item offers no Delete and refuses it", async ({ page }) => {
  const slot = upcomingSlot(5, 10, 15);
  const posted = `Posted item that stays ${run}.`;
  const postedId = await schedule(page, posted, slot);
  expect((await cronTick(page, jwt, slot.utc + 1000)).posted).toBe(1);
  await expectNoDelete(page, posted, ["/history", "/?status=all"]);
  await expectRefused(page, postedId, "posted");
  await shot(page, "refused-posted-history");
  expect((await postedTexts()).filter((text) => text === posted)).toEqual([posted]);
});

// After the delete: Send again is gone (404), two clock-controlled ticks and
// the real cron handler run, and X never accepts the text.
async function expectNeverPosts(page: Page, id: string, text: string, now: number, attempts: number): Promise<void> {
  const retry = await page.request.post(`/api/items/${id}/retry`, {
    headers: { "content-type": "application/json", "x-csrf-token": await csrf(page) },
    data: { position: 0, confirm: true },
  });
  expect(retry.status()).toBe(404);
  await cronTick(page, jwt, now);
  await cronTick(page, jwt, now + 120_000);
  expect((await page.request.get("/cdn-cgi/local/scheduled")).ok()).toBe(true);
  expect((await postedTexts()).filter((sent) => sent === text)).toEqual([]);
  expect((await attemptedTexts()).filter((sent) => sent === text)).toHaveLength(attempts);
}

test("a failed post deleted from History stays gone, and no retry or tick sends it", async ({ page }) => {
  await setMockX({ tweetStatus: 402 });
  const slot = upcomingSlot(5, 10, 45);
  const text = `Failed post to delete ${run}.`;
  const id = await schedule(page, text, slot);
  await cronTick(page, jwt, slot.utc + 1000);
  await setMockX({ tweetStatus: 0 });
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "X API credits are empty.", exact: true })).toHaveCount(1);
  await shot(page, "failed-1-before");

  await deleteWithKeyboard(page, text, "Delete this failed post?");
  await expect(page).toHaveURL(/\/history\?notice=deleted$/);
  await shot(page, "failed-2-after-delete");
  await page.reload();
  await expect(page.getByRole("button", { name: `Delete: ${text}` })).toHaveCount(0);
  await expect(page.getByText(text)).toHaveCount(0);
  await shot(page, "failed-3-after-reload");
  await expectGone(page, id, text, ["/history", "/?status=needs_you", "/?status=all", "/queue"]);
  await expectNeverPosts(page, id, text, slot.utc + 60_000, 1);
});

test("an unconfirmed post deleted from the dashboard stays gone, and no retry or tick sends it", async ({ page }) => {
  // The mock never answers this tweet, so the client times out and the
  // outcome is unknown.
  await setMockX({ failOnTweet: 1 });
  const slot = upcomingSlot(6, 8, 15);
  const text = `Unconfirmed post to delete ${run}.`;
  const id = await schedule(page, text, slot);
  await cronTick(page, jwt, slot.utc + 1000);
  await cronTick(page, jwt, slot.utc + 1000);
  await setMockX({ failOnTweet: 0 });
  const item = (await (await page.request.get(`/api/items/${id}`)).json()) as {
    item: { status: string; needs_reason: string };
  };
  expect(item.item).toMatchObject({ status: "needs_you", needs_reason: "unknown" });
  // Delete waits for the last attempt exactly like Send again does.
  await expect(async () => {
    await page.goto("/history");
    await expect(page.getByRole("button", { name: /^It didn't post\. Send/ })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.goto("/?status=needs_you");
  await shot(page, "unconfirmed-1-before");
  const dialog = page.locator(`dialog[id="delete-${id}"]`);
  await expect(dialog).toContainText("X may already have it");

  await deleteWithKeyboard(page, text, "Delete this unconfirmed post?");
  await expect(page).toHaveURL(/\/\?notice=deleted$/);
  await shot(page, "unconfirmed-2-after-delete");
  await page.reload();
  await expect(page.getByRole("button", { name: `Delete: ${text}` })).toHaveCount(0);
  await shot(page, "unconfirmed-3-after-reload");
  await expectGone(page, id, text, ["/?status=needs_you", "/history", "/?status=all"]);
  await expectNeverPosts(page, id, text, slot.utc + 60_000, 1);
});
