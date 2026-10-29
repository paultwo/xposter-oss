import { expect, type APIResponse, type Page } from "@playwright/test";
import { SHOTS } from "./artifacts";

const MOCK_X = "http://127.0.0.1:9099";

export async function sign(): Promise<string> {
  const response = await fetch(`${MOCK_X}/__sign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "you@example.com" }),
  });
  return response.text();
}

export async function signIn(page: Page): Promise<string> {
  const jwt = await sign();
  await page.context().setExtraHTTPHeaders({ "cf-access-jwt-assertion": jwt });
  return jwt;
}

export async function resetMockX(): Promise<void> {
  await fetch(`${MOCK_X}/__control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reset: true }),
  });
}

export async function setMockX(control: Record<string, number | string>): Promise<void> {
  await fetch(`${MOCK_X}/__control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(control),
  });
}

type MockState = { tweetTexts: string[]; postedTexts: string[] };

async function mockState(): Promise<MockState> {
  return (await (await fetch(`${MOCK_X}/__state`)).json()) as MockState;
}

// Every text the mock received on POST /2/tweets since the last reset,
// including the ones it answered with an error.
export async function attemptedTexts(): Promise<string[]> {
  return (await mockState()).tweetTexts;
}

// Only the texts the mock accepted with a 201.
export async function postedTexts(): Promise<string[]> {
  return (await mockState()).postedTexts;
}

export async function csrf(page: Page): Promise<string> {
  return (await page.locator('meta[name="csrf"]').getAttribute("content")) ?? "";
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/delete/${name}.png`, fullPage: true });
}

export async function saveDraft(page: Page, text: string): Promise<string> {
  await page.goto("/compose");
  await page.locator("#text-0").fill(text);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  const id = new URL(page.url()).pathname.match(/^\/items\/([0-9A-Z]{26})$/)?.[1];
  if (!id) throw new Error(`no item id in ${page.url()}`);
  return id;
}

export async function apiDelete(page: Page, id: string, body: unknown = { confirm: true }): Promise<APIResponse> {
  return page.request.delete(`/api/items/${id}`, {
    headers: { "content-type": "application/json", "x-csrf-token": await csrf(page) },
    data: body,
  });
}

export async function apiStatus(page: Page, id: string): Promise<number> {
  return (await page.request.get(`/api/items/${id}`)).status();
}

// Opens the Delete dialog for the row whose first line is `text`, checks
// that Cancel keeps it, then confirms.
export async function deleteFromList(page: Page, text: string, title: string): Promise<void> {
  const opener = page.getByRole("button", { name: `Delete: ${text}` });
  await expect(opener).toHaveCount(1);
  const dialogId = await opener.getAttribute("data-dialog");
  const dialog = page.locator(`dialog[id="${dialogId}"]`);
  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(title);
  await expect(dialog).toContainText(text);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveJSProperty("open", false);
  await page.reload();
  await expect(opener).toHaveCount(1);
  await opener.click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Deleted. It will not post.")).toBeVisible();
}

// The same dialog, driven only from the keyboard: Tab-reachable opener with
// a label, Cancel focused on open, Escape returns focus to the opener.
export async function deleteWithKeyboard(page: Page, text: string, title: string): Promise<void> {
  const opener = page.getByRole("button", { name: `Delete: ${text}` });
  await expect(opener).toHaveCount(1);
  await expect(opener).toHaveAccessibleName(`Delete: ${text}`);
  const dialogId = await opener.getAttribute("data-dialog");
  const dialog = page.locator(`dialog[id="${dialogId}"]`);
  await page.locator("body").focus();
  for (let step = 0; step < 80; step++) {
    await page.keyboard.press("Tab");
    if (await opener.evaluate((node) => node === document.activeElement)) break;
  }
  await expect(opener).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveJSProperty("open", true);
  await expect(page.getByRole("dialog", { name: title })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveJSProperty("open", false);
  await expect(opener).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Deleted. It will not post.")).toBeVisible();
}

export async function expectGone(page: Page, id: string, text: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: `Delete: ${text}` })).toHaveCount(0);
    await expect(page.getByText(text)).toHaveCount(0);
  }
  expect(await apiStatus(page, id)).toBe(404);
}
