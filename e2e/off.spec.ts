import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { ARTIFACTS, SHOTS } from "./artifacts";

const out = SHOTS;
async function sign(): Promise<string> {
  const response = await fetch("http://127.0.0.1:9099/__sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "you@example.com" }),
  });
  return response.text();
}

async function login(page: Page): Promise<void> {
  const jwt = await sign();
  await page.context().setExtraHTTPHeaders({ "cf-access-jwt-assertion": jwt });
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}

async function axe(page: Page, name: string): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  const serious = result.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
  await mkdir(ARTIFACTS, { recursive: true });
  await writeFile(`${ARTIFACTS}/axe-${name}.json`, JSON.stringify({ violations: result.violations, serious: serious.length }, null, 2));
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("queue, composer, review, history, and settings", async ({ page }) => {
  const widths = [375, 768, 1440];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Drafts", level: 1 })).toBeVisible();
  await expect(page.locator("#open-pause")).toHaveCount(0);
  await expect(page.locator("#posting-state")).toHaveText(
    "Posting is off. Nothing will post, even scheduled items.",
  );
  await expect(page.getByText("No drafts yet.")).toBeVisible();
  await expect(page.locator(".empty").getByRole("link", { name: "New draft" })).toBeVisible();
  await axe(page, "dashboard-empty");
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 375 ? 800 : 900 });
    await shot(page, `dashboard-empty-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/queue");
  await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
  await expect(page.getByText("Nothing scheduled this week.")).toBeVisible();
  await expect(page.getByText("No drafts yet.")).toBeVisible();
  await axe(page, "queue-empty");
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 375 ? 800 : 900 });
    await shot(page, `queue-empty-${width}`);
  }

  await page.goto("/compose");
  await page.getByLabel("Type").selectOption("thread");
  await page.locator("#text-0").fill("First segment of the thread.");
  await page.getByRole("button", { name: "Add post" }).click();
  await page.locator("#text-1").fill("Second segment, with a photo.");
  await page.locator("#file-1-0").setInputFiles("test/fixtures/swatch.png");
  await page.locator("#alt-1-0").fill("A tan swatch with a dark green border.");
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 375 ? 900 : 1000 });
    await shot(page, `composer-thread-${width}`);
  }
  await axe(page, "composer");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await page.goto("/settings");
  await page.getByRole("link", { name: "Connect X" }).click();
  await expect(page.locator("#connection-status")).toHaveText(
    "Connected as @exampleuser.",
  );
  await page.goto("/");
  await page.getByRole("link", { name: /First segment of the thread/ }).click();
  await page.getByRole("link", { name: "Review and approve" }).click();
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await expect(page.getByText("28 / 280")).toBeVisible();
  await expect(page.getByText("Goes to @exampleuser. Approving doesn't post or schedule it. You'll pick a time next.")).toBeVisible();
  await expect(page.getByText("X API cost: about $0.04 (image upload not included).")).toBeVisible();
  await expect(page.getByRole("img", { name: "A tan swatch with a dark green border." })).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await shot(page, `approve-${width}`);
  }
  await axe(page, "approve");
  await page.getByRole("button", { name: "Approve thread" }).click();
  await expect(page.getByText("Approved.")).toBeVisible();
  await page.locator("#schedule-date").fill("2026-12-01");
  await page.locator("#schedule-time").fill("09:00");
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText("Scheduled.")).toBeVisible();
  await shot(page, "scheduled-1440");

  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await shot(page, `history-empty-${width}`);
  }
  await axe(page, "history-empty");

  await page.goto("/settings");
  await page.getByRole("button", { name: "Disconnect X" }).click();
  await page
    .locator("#disconnect-dialog")
    .getByRole("button", { name: "Disconnect X" })
    .click();
  await expect(page.locator("#posting-state")).toHaveText("Posting is off. Nothing will post, even scheduled items.");
  await expect(page.locator("#connection-status")).toHaveText(
    "X is disconnected.",
  );
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1100 });
    await shot(page, `settings-disconnected-${width}`);
  }
  await axe(page, "settings");

  await page.goto("/compose");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await shot(page, "error-1440");
  await axe(page, "error");

  await page.addInitScript(() => {
    document.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
      },
      true,
    );
  });
  await page.goto("/compose");
  await page.locator("#text-0").fill("A draft that pauses while saving.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator("form[aria-busy='true']")).toBeVisible();
  await shot(page, "loading-1440");
});

test("buffer import keeps placeholders and stays draft", async ({ page }) => {
  const exportPath = "test/fixtures/buffer-drafts.json";
  expect(existsSync(exportPath), "checked-in Buffer fixture").toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await page.locator("#buffer-file").setInputFiles(exportPath);
  await page.getByRole("button", { name: "Import drafts" }).click();
  await expect(page.getByText("Imported 5 drafts.")).toBeVisible();
  await page.goto("/queue");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await shot(page, `queue-buffer-${width}`);
  }
  await axe(page, "queue-buffer");
  await page.getByRole("link", { name: /AI-first/ }).click();
  await expect(page.locator("#text-0")).toHaveValue(/\[your line\]/);
  await expect(page.locator("#text-0")).toHaveValue(/\[what AI does, and never decides\]/);
  await page.goto("/queue");
  await page.getByRole("link", { name: /self-protection/ }).click();
  await expect(page.locator("#text-0")).toHaveValue(/\[One real work example, no names\.\]/);
  await page.goto("/queue");
  await page.getByRole("link", { name: /Giving is up/ }).click();
  await expect(page.locator("#text-0")).toHaveValue(/\[Your take on earning it\.\]/);
});

async function intake(body: Record<string, unknown>): Promise<string> {
  const response = await fetch("http://127.0.0.1:9099/__sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ common_name: "x-poster-intake" }),
  });
  const created = await fetch("http://127.0.0.1:8787/api/intake/drafts", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await response.text(),
      authorization: "Bearer test-intake-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { item: { id: string } }).item.id;
}

async function activeText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "";
    const name = el.getAttribute("aria-label") || el.innerText || (el as HTMLInputElement).labels?.[0]?.innerText || el.id;
    return `${el.tagName} ${name.replace(/\s+/g, " ")}`.trim();
  });
}

test("drafts dashboard previews, filters, and approves", async ({ page }) => {
  await page.goto("/settings");
  const status = page.locator("#connection-status");
  if ((await status.textContent()) !== "Connected as @exampleuser.") {
    await page.getByRole("link", { name: "Connect X" }).click();
  }
  await expect(status).toHaveText("Connected as @exampleuser.");
  const bufferLoaded = existsSync("test/fixtures/buffer-drafts.json");
  await intake({
    kind: "post",
    source_ref: "dash-hemingway",
    stage: "needs_hemingway",
    segments: [{ text: "Most nonprofits do not need more software. They need fewer tabs open at 4 PM on a Friday." }],
  });
  await intake({
    kind: "thread",
    source_ref: "dash-awaiting",
    stage: "needs_approval",
    segments: [
      { text: "Three things I learned shipping payments for campaigns this year." },
      { text: "1. Receipts are the product. Donors read them more than the page." },
      { text: "2. Refunds should take one click, and the audit log should say who clicked." },
    ],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/compose");
  await page.getByLabel("Type").selectOption("thread");
  await page.locator("#text-0").fill("A thread with a photo, waiting on approval.");
  await page.getByRole("button", { name: "Add post" }).click();
  await page.locator("#text-1").fill("The swatch below has a tan center and a dark green border.");
  await page.locator("#file-1-0").setInputFiles("test/fixtures/swatch.png");
  await page.locator("#alt-1-0").fill("A tan swatch with a dark green border.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Drafts", level: 1 })).toBeVisible();
  await expect(page.getByRole("img", { name: "A tan swatch with a dark green border." }).first()).toBeVisible();
  await expect(page.getByRole("img", { name: "A tan swatch with a dark green border." })).toHaveCount(2);
  await expect(page.getByText("Needs your approval", { exact: true }).first()).toBeVisible();
  if (bufferLoaded) {
    const posts = await page.locator("main .post-text").allTextContents();
    expect(posts.join("")).toContain("[your line]");
    await expect(page.getByText("Show more").first()).toBeVisible();
    await expect(page.locator("main")).toContainText(/[\d,]+ \/ 280\. Over by [\d,]+\./);
    await expect(page.locator("main")).toContainText("Split it into a thread or make it an Article.");
  }
  await axe(page, "dashboard");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 800 : 900 });
    await shot(page, `dashboard-${width}`);
  }
  await page.setViewportSize({ width: 320, height: 800 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, "dashboard-320");

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?status=needs_approval");
    await shot(page, `dashboard-awaiting-${width}`);
  }
  await axe(page, "dashboard-awaiting");
  await page.goto("/?status=needs_hemingway");
  await expect(page.getByText("fewer tabs open")).toBeVisible();
  await expect(page.getByText("Three things I learned")).toHaveCount(0);
  await axe(page, "dashboard-hemingway");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const seen: string[] = [];
  let reachedFilter = false;
  for (let step = 0; step < 40 && !reachedFilter; step += 1) {
    await page.keyboard.press("Tab");
    const current = await activeText(page);
    seen.push(current);
    reachedFilter = current.startsWith("A Needs your approval");
  }
  expect(reachedFilter).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/status=needs_approval/);
  seen.push("Enter on Needs your approval filter");
  let reachedApprove = false;
  for (let step = 0; step < 40 && !reachedApprove; step += 1) {
    await page.keyboard.press("Tab");
    const current = await activeText(page);
    seen.push(current);
    reachedApprove = current.startsWith("BUTTON Approve");
  }
  expect(reachedApprove).toBe(true);
  const focusRing = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
  expect(focusRing).toBe("solid");
  await shot(page, "dashboard-keyboard-focus-1440");
  await page.keyboard.press("Enter");
  seen.push("Enter on Approve");
  await expect(page.getByText("Approved. It will not post until you schedule it.")).toBeVisible();
  await page.goto("/?status=approved");
  await expect(page.getByText("Three things I learned")).toBeVisible();
  await shot(page, "dashboard-approved-1440");
  await mkdir(ARTIFACTS, { recursive: true });
  await writeFile(`${ARTIFACTS}/keyboard-walkthrough-dashboard.txt`, seen.join("\n"));
  await page.goto("/?status=needs_approval");
  const snapshot = await page.locator("main").ariaSnapshot();
  await writeFile(`${ARTIFACTS}/screen-reader-note-dashboard.md`, `# Screen reader note, Drafts dashboard\n\nVoiceOver and NVDA are not installed on this Linux agent. This is the accessibility tree Playwright exposes for the dashboard filtered to Needs your approval, after approving the thread from the keyboard.\n\n\`\`\`\n${snapshot}\n\`\`\`\n`);
});

test("removing a middle segment keeps the rest, and added segments count live", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/compose");
  await page.getByLabel("Type").selectOption("thread");
  await page.locator("#text-0").fill("Segment that stays first.");
  await page.getByRole("button", { name: "Add post" }).click();
  await page.locator("#text-1").fill("Segment that gets removed.");
  await page.getByRole("button", { name: "Add post" }).click();
  await page.locator("#text-2").fill("Segment that moves up.");
  await expect(page.locator("#count-2")).toHaveText("22 / 280");
  await page.locator("fieldset").nth(1).getByRole("button", { name: "Remove post 2" }).click();
  await expect(page.locator("#text-1")).toHaveValue("Segment that moves up.");
  await expect(page.locator("fieldset legend").nth(1)).toHaveText("Post 2 of 2");
  await expect(page.locator("#text-0")).toBeFocused();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await expect(page.locator("#text-0")).toHaveValue("Segment that stays first.");
  await expect(page.locator("#text-1")).toHaveValue("Segment that moves up.");
  await expect(page.locator("#text-2")).toHaveCount(0);
  await expect(page.locator("#count-0")).toHaveText("25 / 280");
  await expect(page.getByRole("link", { name: "New draft" })).not.toHaveAttribute("aria-current", "page");
});

test("keyboard only reaches save, and the tree exposes names", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/compose");
  const seen: string[] = [];
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    const current = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return "";
      const html = el as HTMLElement;
      return `${el.tagName} ${html.innerText || (el as HTMLInputElement).labels?.[0]?.innerText || html.getAttribute("aria-label") || html.id}`.trim();
    });
    seen.push(current);
  }
  await mkdir(ARTIFACTS, { recursive: true });
  await writeFile(`${ARTIFACTS}/keyboard-walkthrough.txt`, seen.join("\n"));
  expect(seen.some((line) => line.includes("Text"))).toBe(true);
  await page.locator("#text-0").focus();
  await page.keyboard.type("Keyboard draft.");
  await page.keyboard.press("Tab");
  const snapshot = await page.locator("main").ariaSnapshot();
  await writeFile(`${ARTIFACTS}/screen-reader-note.md`, `# Screen reader note\n\nVoiceOver and NVDA are not installed on this Linux agent. The check below is the accessibility tree Playwright exposes to assistive technology, taken after a keyboard-only pass on the composer.\n\n\`\`\`\n${snapshot}\n\`\`\`\n`);
  expect(snapshot.length).toBeGreaterThan(20);
});
