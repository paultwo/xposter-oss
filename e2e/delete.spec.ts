import { expect, test } from "@playwright/test";
import { apiDelete, apiStatus, csrf, deleteFromList, expectGone, saveDraft, shot, signIn } from "./delete-kit";

const run = Date.now().toString(36);

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("a draft deleted from the Drafts dashboard stays gone after a reload", async ({ page }) => {
  const text = `Dashboard draft to delete ${run}.`;
  const id = await saveDraft(page, text);
  await page.goto("/");
  await expect(page.getByRole("button", { name: `Delete: ${text}` })).toHaveCount(1);
  await shot(page, "dashboard-1-before");

  await deleteFromList(page, text, "Delete this draft?");
  await expect(page).toHaveURL(/\/\?notice=deleted$/);
  await shot(page, "dashboard-2-after-delete");
  await page.reload();
  await expect(page.getByRole("button", { name: `Delete: ${text}` })).toHaveCount(0);
  await expect(page.getByText(text)).toHaveCount(0);
  await shot(page, "dashboard-3-after-reload");

  await expectGone(page, id, text, ["/", "/?status=all", "/queue", "/archived"]);
});

test("an archived draft deleted from Archived stays gone after a reload", async ({ page }) => {
  const text = `Archived draft to delete ${run}.`;
  const id = await saveDraft(page, text);
  await page.goto(`/items/${id}/review`);
  await page.locator("#open-archive").click();
  await page.locator("#archive-dialog").getByRole("button", { name: "Archive" }).click();
  await expect(page).toHaveURL(/notice=archived/);
  await page.goto("/archived");
  await shot(page, "archived-1-before");

  await deleteFromList(page, text, "Delete this archived draft?");
  await expect(page).toHaveURL(/\/archived\?notice=deleted$/);
  await shot(page, "archived-2-after-delete");
  await page.reload();
  await expect(page.getByRole("button", { name: `Delete: ${text}` })).toHaveCount(0);
  await shot(page, "archived-3-after-reload");

  await expectGone(page, id, text, ["/archived", "/?status=all"]);
});

test("the JSON API deletes only with confirm, then returns 404", async ({ page }) => {
  await page.goto("/");
  const text = `API draft to delete ${run}.`;
  const created = await page.request.post("/api/items", {
    headers: { "content-type": "application/json", "x-csrf-token": await csrf(page) },
    data: { kind: "post", segments: [{ text }] },
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { item: { id: string } }).item.id;

  const unconfirmed = await apiDelete(page, id, {});
  expect(unconfirmed.status()).toBe(409);
  expect(await apiStatus(page, id)).toBe(200);
  const noToken = await page.request.delete(`/api/items/${id}`, {
    headers: { "content-type": "application/json" },
    data: { confirm: true },
  });
  expect(noToken.status()).toBe(403);
  expect(await apiStatus(page, id)).toBe(200);

  const deleted = await apiDelete(page, id);
  expect(deleted.status()).toBe(200);
  expect(await deleted.json()).toEqual({ deleted: true, id, was: "draft" });
  expect((await apiDelete(page, id)).status()).toBe(404);
  await expectGone(page, id, text, ["/?status=all"]);
});
