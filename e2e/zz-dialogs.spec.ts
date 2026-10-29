import { expect, test, type Page } from "@playwright/test";
import { cycleDialogFocus } from "./dialog-focus";
import { upcomingSlot } from "./slot";

async function sign(): Promise<string> {
  const response = await fetch("http://127.0.0.1:9099/__sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "you@example.com" }),
  });
  return response.text();
}

async function connectPlan(page: Page, subscriptionType: string): Promise<void> {
  await fetch("http://127.0.0.1:9099/__control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscriptionType }),
  });
  await page.goto("/settings");
  const status = page.locator("#connection-status");
  const reconnect = page.getByRole("link", { name: "Reconnect X" });
  if ((await reconnect.count()) > 0) {
    await reconnect.click();
  } else {
    await page.getByRole("link", { name: "Connect X" }).click();
  }
  await expect(status).toHaveText("Connected as @exampleuser.");
}

async function approvePost(page: Page, text: string): Promise<void> {
  await page.goto("/settings");
  if (
    (await page.locator("#connection-status").textContent()) !==
    "Connected as @exampleuser."
  ) {
    await connectPlan(page, "None");
  }
  await page.goto("/compose");
  await page.locator("#text-0").fill(text);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await page.getByRole("link", { name: "Review and approve" }).click();
  await page.getByRole("button", { name: "Approve post" }).click();
  await expect(page.getByText("Approved.")).toBeVisible();
}

async function dialogCycle(
  page: Page,
  openId: string,
  dialogId: string,
): Promise<void> {
  const opener = page.locator(`#${openId}`);
  await opener.click();
  const dialog = page.locator(`#${dialogId}`);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await cycleDialogFocus(page, dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveJSProperty("open", false);
  await expect(opener).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await page.context().setExtraHTTPHeaders({
    "cf-access-jwt-assertion": await sign(),
  });
});

test.afterAll(async () => {
  await fetch("http://127.0.0.1:9099/__control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subscriptionType: "None" }),
  });
});

test("archive and post-now dialogs return focus, and post now submits once", async ({
  page,
}) => {
  await approvePost(page, "Dialog post that goes out in a minute.");
  await dialogCycle(page, "open-archive", "archive-dialog");
  await expect(page.getByText("can't get it back")).toHaveCount(0);
  await dialogCycle(page, "open-post-now", "post-now");
  let hits = 0;
  await page.route(
    (url) => url.pathname.endsWith("/post-now"),
    async (route) => {
      hits += 1;
      await route.continue();
    },
  );
  await page.locator("#open-post-now").click();
  const busy = await page.evaluate(() => {
    const form = document.querySelector("#post-now form");
    if (!(form instanceof HTMLFormElement)) return null;
    form.requestSubmit();
    form.requestSubmit();
    const button = form.querySelector("button.danger");
    return {
      aria: button?.getAttribute("aria-busy") ?? "",
      text: button?.textContent ?? "",
    };
  });
  expect(busy).toEqual({ aria: "true", text: "Scheduling…" });
  await expect(page.getByText("Scheduled.")).toBeVisible();
  expect(hits).toBe(1);
});

test("schedule shows a busy state and sends one request", async ({ page }) => {
  await approvePost(page, "Dialog post that is scheduled once.");
  const slot = upcomingSlot(2, 16, 15);
  await page.locator("#schedule-date").fill(slot.date);
  await page.locator("#schedule-time").fill(slot.time);
  let hits = 0;
  await page.route(
    (url) => url.pathname.endsWith("/schedule"),
    async (route) => {
      hits += 1;
      await route.continue();
    },
  );
  const busy = await page.evaluate(() => {
    const form = document.querySelector("form.schedule");
    if (!(form instanceof HTMLFormElement)) return null;
    form.requestSubmit();
    form.requestSubmit();
    const button = form.querySelector("button[type=submit]");
    return {
      aria: button?.getAttribute("aria-busy") ?? "",
      text: button?.textContent ?? "",
    };
  });
  expect(busy).toEqual({ aria: "true", text: "Scheduling…" });
  await expect(page.getByText("Scheduled.")).toBeVisible();
  expect(hits).toBe(1);
});

test("the composer limit follows Premium on the connected account", async ({
  page,
}) => {
  const long = "x".repeat(400);
  await connectPlan(page, "None");
  await page.goto("/compose");
  await page.locator("#text-0").fill(long);
  await expect(page.getByText("Long posts need X Premium.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Keep as a long post" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Split into a thread" }),
  ).toBeVisible();
  await expect(page.locator("#count-0")).toContainText("400 / 280");
  await expect(page.locator("#count-0")).toContainText("Over by");

  await connectPlan(page, "Premium");
  await page.goto("/compose");
  await page.locator("#text-0").fill(long);
  await expect(page.locator("#count-0")).toHaveText("400 / 25,000");
  await expect(page.locator("#count-0")).not.toContainText("Over");
  await expect(page.getByText("Longer than 280 characters")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Keep as a long post" }),
  ).toBeEnabled();

  await connectPlan(page, "None");
});

test("delete asks first, Cancel keeps the draft, and Delete removes a queued post", async ({
  page,
}) => {
  await approvePost(page, "Queued post that gets deleted.");
  const slot = upcomingSlot(3, 11, 45);
  await page.locator("#schedule-date").fill(slot.date);
  await page.locator("#schedule-time").fill(slot.time);
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByText("Scheduled.", { exact: true })).toBeVisible();

  await page.goto("/queue");
  const opener = page
    .getByRole("button", {
      name: "Delete: Queued post that gets deleted.",
    })
    .last();
  await opener.click();
  const dialogId = await opener.first().getAttribute("data-dialog");
  const dialog = page.locator(`dialog[id="${dialogId}"]`);
  await expect(dialog).toContainText("Delete this scheduled post?");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("will not post to X");
  await expect(dialog).toContainText("Queued post that gets deleted.");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveJSProperty("open", false);
  await expect(opener).toBeFocused();
  const before = await page
    .getByRole("button", { name: "Delete: Queued post that gets deleted." })
    .count();

  await opener.click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/queue\?notice=deleted$/);
  await expect(page.getByText("Deleted. It will not post.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete: Queued post that gets deleted." }),
  ).toHaveCount(before - 1);
  await expect(page.locator(`dialog[id="${dialogId}"]`)).toHaveCount(0);
});
