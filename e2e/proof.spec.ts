import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { etParts, etToUtc, formatDue, formatEtDay } from "../src/lib/time";
import { upcomingSlot } from "./slot";

const out = "/opt/cursor/artifacts/screenshots";

async function sign(): Promise<string> {
  const response = await fetch("http://127.0.0.1:9099/__sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "you@example.com" }),
  });
  return response.text();
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}

async function axe(page: Page, name: string): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const serious = result.violations.filter(
    (item) => item.impact === "serious" || item.impact === "critical",
  );
  await mkdir("/opt/cursor/artifacts", { recursive: true });
  await writeFile(
    `/opt/cursor/artifacts/axe-${name}.json`,
    JSON.stringify(
      { violations: result.violations, serious: serious.length },
      null,
      2,
    ),
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  const jwt = await sign();
  await page.context().setExtraHTTPHeaders({ "cf-access-jwt-assertion": jwt });
});

test("dark mode, scheduled queue, post-now, photo preview, and connected settings", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await axe(page, "dark-dashboard");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 800 : 900 });
    await shot(page, `dark-dashboard-${width}`);
  }
  await page.goto("/compose");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 900 : 1000 });
    await shot(page, `dark-composer-${width}`);
  }
  await page.goto("/settings");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await shot(page, `dark-settings-${width}`);
  }
  await axe(page, "dark-settings");
  await page.emulateMedia({ colorScheme: "light" });

  await page.setViewportSize({ width: 1024, height: 900 });
  for (const [path, name] of [
    ["/", "dashboard"],
    ["/queue", "queue"],
    ["/compose", "composer"],
    ["/history", "history"],
    ["/settings", "settings"],
  ] as const) {
    await page.goto(path);
    await shot(page, `${name}-1024`);
    await axe(page, `${name}-1024`);
  }

  await page.goto("/settings");
  const status = page.locator("#connection-status");
  if ((await status.textContent()) !== "Connected as @exampleuser.") {
    await page.getByRole("link", { name: "Connect X" }).click();
  }
  await expect(status).toHaveText("Connected as @exampleuser.");

  await page.goto("/compose");
  await page
    .locator("#text-0")
    .fill("A hibiscus, and the note: https://www.example.org/giving");
  await page.locator("#file-0-0").setInputFiles("test/fixtures/flower.jpg");
  await page
    .locator("#alt-0-0")
    .fill("A red hibiscus with a yellow stamen on a white background.");
  await page.setViewportSize({ width: 320, height: 900 });
  await shot(page, "composer-photo-320");
  await page.setViewportSize({ width: 1024, height: 900 });
  await shot(page, "composer-photo-1024");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".link-card:not([hidden])").first()).toContainText(
    "www.example.org",
  );
  await expect(page.locator("a.post-link").first()).toBeVisible();
  await shot(page, "composer-photo-1440");
  await axe(page, "composer-photo");

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await page.getByRole("link", { name: "Review and approve" }).click();
  await expect(page.locator(".link-card").first()).toContainText("www.example.org");
  await expect(page.locator(".link-card").first()).toContainText("/giving");
  await expect(
    page.getByRole("img", {
      name: "A red hibiscus with a yellow stamen on a white background.",
    }),
  ).toBeVisible();
  await expect(page.locator("img.x-avatar").first()).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  await shot(page, "approve-photo-320");
  await page.setViewportSize({ width: 1024, height: 900 });
  await shot(page, "approve-photo-1024");
  await axe(page, "approve-photo");

  await page.getByRole("button", { name: "Approve post" }).click();
  await expect(page.getByText("Approved.")).toBeVisible();
  await page.getByRole("button", { name: "Post in 60 seconds" }).click();
  await expect(
    page.getByRole("heading", { name: "Post this post to @exampleuser now?" }),
  ).toBeVisible();
  await expect(page.getByText(/1 post goes live on X at about/)).toBeVisible();
  await expect(page.getByText("You can't undo this here.")).toBeVisible();
  await shot(page, "post-now-dialog-1024");
  await axe(page, "post-now-dialog");
  await page.getByRole("button", { name: "Cancel" }).click();

  const queued = upcomingSlot();
  await page.locator("#schedule-date").fill(queued.date);
  await page.locator("#schedule-time").fill(queued.time);
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText("Scheduled.")).toBeVisible();
  await page.goto("/queue");
  await expect(page.getByRole("link", { name: /hibiscus/ })).toBeVisible();
  await shot(page, "queue-scheduled-1024");
  await axe(page, "queue-scheduled");
  await page.getByRole("link", { name: /hibiscus/ }).click();
  await expect(page.getByRole("button", { name: "Unschedule" })).toBeVisible();
  await shot(page, "unschedule-1024");
  await axe(page, "unschedule");

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/history");
  await shot(page, "history-320");
  await axe(page, "history-320");

  await page.setViewportSize({ width: 1024, height: 1100 });
  await page.goto("/settings");
  await page.locator("#token-name").fill("desk-bot");
  await page.getByRole("button", { name: "Create bot token" }).click();
  await expect(page.getByText("desk-bot", { exact: true })).toBeVisible();
  await expect(page.getByText("Bots use a token to send drafts.")).toBeVisible();
  await shot(page, "settings-connected-1024");
  await page.getByRole("button", { name: "Disconnect X" }).click();
  await expect(page.getByRole("heading", { name: "Disconnect X" })).toBeVisible();
  await shot(page, "settings-disconnect-1024");
  await axe(page, "settings-connected");
  await page.getByRole("button", { name: "Cancel" }).click();

  const clock = Date.now();
  const yesterday = pastNoon(clock, 1);
  const threeDaysAgo = pastNoon(clock, 3);
  const yesterdayId = await schedulePost(page, "This draft was due yesterday.");
  const olderId = await schedulePost(page, "This draft was due three days ago.");
  await storeDue(yesterdayId, yesterday);
  await storeDue(olderId, threeDaysAgo);
  const csrf = await page.locator("input[name='csrf']").first().inputValue();
  const dispatched = await page.request.post("/__dev/dispatch", {
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "cf-access-jwt-assertion": await sign(),
    },
    data: { now: clock },
  });
  expect(dispatched.ok()).toBe(true);
  expect(await dispatched.json()).toMatchObject({
    posted: 0,
    skipped: "posting_disabled",
  });
  await page.clock.install({ time: clock });
  await page.goto("/");
  await expect(page.getByText("This draft was due yesterday.")).toBeVisible();
  await expect(page.getByText("This draft was due three days ago.")).toBeVisible();
  await expect(page.getByText(missedLine(yesterday)).first()).toBeVisible();
  await expect(page.getByText(missedLine(threeDaysAgo)).first()).toBeVisible();
  await page.goto("/queue");
  await expect(page.getByRole("heading", { name: "Missed" })).toBeVisible();
  await expect(page.getByText("This draft was due yesterday.")).toBeVisible();
  await expect(page.getByText("This draft was due three days ago.")).toBeVisible();
  await expect(page.getByText(missedLine(yesterday))).toBeVisible();
  await expect(page.getByText(missedLine(threeDaysAgo))).toBeVisible();
  await expect(page.getByRole("link", { name: "Reschedule" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Post|Schedule|Send/ })).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: formatEtDay(yesterday, ZONE),
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: formatEtDay(threeDaysAgo, ZONE),
      exact: true,
    }),
  ).toHaveCount(0);
  await page.emulateMedia({ colorScheme: "light" });
  const shots = "/opt/cursor/artifacts/screenshots/design-r4";
  await mkdir(shots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: `${shots}/queue-missed-light-1440.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.screenshot({
    path: `${shots}/queue-missed-light-375.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/");
  await shot(page, "dashboard-missed-1024");
  await axe(page, "dashboard-missed");
});

const ZONE = "America/New_York";

function missedLine(at: number): string {
  return `Missed: was due ${formatDue(at, ZONE)}. Missed posts never go out late. Reschedule to post it.`;
}

function pastNoon(clock: number, daysAgo: number): number {
  const parts = etParts(clock - daysAgo * 24 * 60 * 60 * 1000, ZONE);
  const at = etToUtc(parts.year, parts.month, parts.day, 12, 0, ZONE);
  const today = etParts(clock, ZONE);
  const due = at === null ? null : etParts(at, ZONE);
  const before =
    due !== null &&
    (due.year < today.year ||
      (due.year === today.year && due.month < today.month) ||
      (due.year === today.year &&
        due.month === today.month &&
        due.day < today.day));
  if (at === null || at >= clock || !before) {
    throw new Error("The stored due time is not before today on the clock.");
  }
  return at;
}

async function schedulePost(page: Page, text: string): Promise<string> {
  await page.goto("/compose");
  await page.locator("#text-0").fill(text);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await page.getByRole("link", { name: "Review and approve" }).click();
  await page.getByRole("button", { name: "Approve post" }).click();
  await expect(page.getByText("Approved.")).toBeVisible();
  const slot = upcomingSlot(2, 10, 0);
  await page.locator("#schedule-date").fill(slot.date);
  await page.locator("#schedule-time").fill(slot.time);
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText("Scheduled.")).toBeVisible();
  const id = new URL(page.url()).pathname.split("/")[2] ?? "";
  if (!id) throw new Error("The scheduled post has no id.");
  return id;
}

async function d1File(): Promise<string> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".sqlite")) found.push(path);
    }
  }
  await walk(".wrangler/proof-off");
  for (const path of found) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'items'",
        )
        .get() as { ok: number } | undefined;
      if (row?.ok === 1) return path;
    } finally {
      db.close();
    }
  }
  throw new Error("Local D1 database was not found.");
}

async function storeDue(id: string, at: number): Promise<void> {
  const db = new DatabaseSync(await d1File());
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const result = db
      .prepare("UPDATE items SET scheduled_at = ? WHERE id = ?")
      .run(at, id);
    db.exec("PRAGMA wal_checkpoint(FULL)");
    if (Number(result.changes) !== 1) {
      throw new Error(`The due time was not stored for ${id}.`);
    }
  } finally {
    db.close();
  }
}
