import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { ARTIFACTS, SHOTS } from "./artifacts";
import { cycleDialogFocus } from "./dialog-focus";
import { upcomingSlot } from "./slot";

const MEDIA = process.env.SHOT_DIR ?? "test-results/shots";
const WCAG = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
  "best-practice",
] as const;
const WIDTHS = [
  [375, 800],
  [768, 900],
  [1440, 900],
] as const;

async function backdropAlpha(page: Page): Promise<number> {
  const color = await page.locator("#pause-dialog").evaluate((node) => {
    return getComputedStyle(node, "::backdrop").backgroundColor;
  });
  const parts = color.match(/[\d.]+/g);
  const alpha = parts && parts.length >= 4 ? Number(parts[3]) : Number.NaN;
  if (!Number.isFinite(alpha)) throw new Error(`backdrop color was ${color}`);
  return alpha;
}

async function pausePosting(page: Page): Promise<void> {
  const csrf = await page.locator('meta[name="csrf"]').getAttribute("content");
  const paused = await page.request.post("/api/settings/pause", {
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrf ?? "",
    },
    data: {},
  });
  expect(paused.ok()).toBeTruthy();
  expect(await paused.json()).toEqual({ posting_paused: true });
}

async function axe(
  page: Page,
  name: string,
  include?: string,
  tags?: readonly string[],
): Promise<void> {
  let builder = new AxeBuilder({ page });
  if (include) builder = builder.include(include);
  if (tags) builder = builder.withTags([...tags]);
  const result = await builder.analyze();
  const serious = result.violations.filter(
    (item) => item.impact === "serious" || item.impact === "critical",
  );
  await mkdir(ARTIFACTS, { recursive: true });
  await writeFile(
    `${ARTIFACTS}/axe-${name}.json`,
    JSON.stringify({ violations: result.violations, serious: serious.length }, null, 2),
  );
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
}

async function sign(body: Record<string, string>): Promise<string> {
  const response = await fetch("http://127.0.0.1:9099/__sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.text();
}

async function dispatchAt(
  page: Page,
  csrf: string,
  jwt: string,
  now: number,
): Promise<APIResponse> {
  return page.request.post("/__dev/dispatch", {
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrf,
      "cf-access-jwt-assertion": jwt,
    },
    data: { now },
    timeout: 20_000,
  });
}

async function connect(page: Page): Promise<void> {
  await page.goto("/settings");
  const status = page.locator("#connection-status");
  if ((await status.textContent()) !== "Connected as @exampleuser.") {
    await page.getByRole("link", { name: "Connect X" }).click();
  }
  await expect(status).toHaveText("Connected as @exampleuser.");
}

test.beforeAll(async () => {
  await mkdir(MEDIA, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await fetch("http://127.0.0.1:9099/__control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reset: true }),
  });
  const jwt = await sign({ email: "you@example.com" });
  await page.context().setExtraHTTPHeaders({ "cf-access-jwt-assertion": jwt });
});

test("draft, approve, schedule, cron, history", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await connect(page);
  await page.goto("/compose");
  await page.getByLabel("Type").selectOption("thread");
  await page.locator("#text-0").fill("Mock segment one.");
  await page.getByRole("button", { name: "Add post" }).click();
  await page.locator("#text-1").fill("Mock segment two.");
  await page.locator("#file-1-0").setInputFiles("test/fixtures/swatch.png");
  await page.locator("#alt-1-0").fill("A tan swatch with a dark green border.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/flow-draft.png`, fullPage: true });
  await page.getByRole("link", { name: "Review and approve" }).click();
  await page.getByRole("button", { name: "Approve thread" }).click();
  await expect(page.getByText("Approved.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/flow-approved.png`, fullPage: true });
  const slot = upcomingSlot();
  await page.locator("#schedule-date").fill(slot.date);
  await page.locator("#schedule-time").fill(slot.time);
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText("Scheduled.")).toBeVisible();
  const csrf = await page.locator("input[name=csrf]").first().inputValue();
  const jwt = await sign({ email: "you@example.com" });
  for (let step = 0; step < 2; step++) {
    const dispatched = await dispatchAt(page, csrf, jwt, slot.utc + 1000);
    expect(dispatched.ok()).toBe(true);
    const body = (await dispatched.json()) as {
      posted: number;
      skipped: string | null;
    };
    expect(body, JSON.stringify(body)).toMatchObject({ posted: 1 });
  }
  await page.goto("/history");
  await expect(page.getByText("Mock segment one.")).toBeVisible();
  await expect(
    page.locator(".history > li", { hasText: "Mock segment one." }).getByText("Posted", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/flow-history.png`, fullPage: true });
  const requests = (await (await fetch("http://127.0.0.1:9099/__requests")).json()) as { requests: Array<{ path: string }> };
  expect(requests.requests.some((item) => item.path.startsWith("/2/dm") || item.path.startsWith("/2/chat"))).toBe(false);
});

test("intake draft shows in the queue, and an edit returns it to draft", async ({ page, request }) => {
  const service = await sign({ common_name: "x-poster-intake" });
  const created = await request.post("/api/intake/drafts", {
    headers: {
      "cf-access-jwt-assertion": service,
      authorization: "Bearer test-intake-token",
      "content-type": "application/json",
    },
    data: { kind: "post", source_ref: "e2e-bot", segments: [{ text: "Draft from the intake API." }] },
  });
  expect(created.status()).toBe(201);
  const createdId = ((await created.json()) as { item: { id: string } }).item.id;
  const staged = await request.patch(`/api/intake/drafts/${createdId}`, {
    headers: {
      "cf-access-jwt-assertion": service,
      authorization: "Bearer test-intake-token",
      "content-type": "application/json",
    },
    data: { stage: "needs_approval" },
  });
  expect(staged.status()).toBe(200);
  await page.goto("/?status=needs_approval");
  await expect(page.locator(".post-text", { hasText: "Draft from the intake API." })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dashboard-intake-awaiting.png`, fullPage: true });
  await page.goto("/queue");
  await expect(page.getByText("Draft from the intake API.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/queue-intake.png`, fullPage: true });
  await page.getByRole("link", { name: "Draft from the intake API." }).click();
  await page.locator("#text-0").fill("Edited after it was only a draft.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("link", { name: "Review and approve" }).click();
  await page.getByRole("button", { name: "Approve post" }).click();
  const intakeSlot = upcomingSlot();
  await page.locator("#schedule-date").fill(intakeSlot.date);
  await page.locator("#schedule-time").fill(intakeSlot.time);
  await page.getByRole("button", { name: "Schedule" }).click();
  await page.getByRole("link", { name: "Back to the draft" }).click();
  await page.locator("#text-0").fill("Edited after approval.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.goto("/queue");
  const row = page.locator("li", { hasText: "Edited after approval." });
  await expect(row.getByText("Draft", { exact: true })).toBeVisible();
});

test("a timeout leaves the thread for you", async ({ page }) => {
  await connect(page);
  await fetch("http://127.0.0.1:9099/__control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ failOnTweet: 2 }),
  });
  await page.goto("/compose");
  await page.getByLabel("Type").selectOption("thread");
  await page.locator("#text-0").fill("Timeout segment one.");
  await page.getByRole("button", { name: "Add post" }).click();
  await page.locator("#text-1").fill("Timeout segment two.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("link", { name: "Review and approve" }).click();
  await page.getByRole("button", { name: "Approve thread" }).click();
  const slot = upcomingSlot();
  await page.locator("#schedule-date").fill(slot.date);
  await page.locator("#schedule-time").fill(slot.time);
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText("Scheduled.")).toBeVisible();
  const csrf = await page.locator("input[name=csrf]").first().inputValue();
  const jwt = await sign({ email: "you@example.com" });
  const first = await dispatchAt(page, csrf, jwt, slot.utc + 1000);
  expect(first.ok()).toBe(true);
  const second = await dispatchAt(page, csrf, jwt, slot.utc + 1000);
  expect(second.ok()).toBe(true);
  await page.goto("/history");
  await expect(
    page.getByRole("heading", {
      name: /^X timed out at \d{1,2}:\d{2} [AP]M (EDT|EST)\. Check X to see whether it posted before you send it again\.$/,
    }),
  ).toBeVisible();
  await page.goto("/");
  const timedOut = page.locator("li", { hasText: "Timeout segment two." });
  await expect(page.locator(".banner")).toContainText(
    /X timed out at \d{1,2}:\d{2} [AP]M (EDT|EST)/,
  );
  await expect(timedOut.locator(".when")).toContainText(
    /X timed out at \d{1,2}:\d{2} [AP]M (EDT|EST)/,
  );
  await page.goto("/history");
  await expect(page.getByRole("link", { name: "Open @exampleuser on X" })).toBeVisible();
  await expect(page.getByRole("button", { name: "It posted (paste its link)" })).toBeVisible();
  await expect(async () => {
    await page.goto("/history");
    await expect(
      page.getByRole("button", { name: "It didn't post. Send post 2 again" }),
    ).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByText("Timeout segment two.")).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await axe(page, `pr3-timeout-375-${scheme}`);
    await page.screenshot({ path: `${MEDIA}/pr3-timeout-375-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("span.stage-needs_you").first()).toBeVisible();
  await expect(page.getByText("Needs you")).toBeVisible();
  const sendAgain = page.getByRole("button", {
    name: "It didn't post. Send post 2 again",
  });
  await sendAgain.click();
  const resend = page.locator("dialog[open]");
  await expect(resend.getByRole("button", { name: "Cancel" })).toBeFocused();
  await cycleDialogFocus(page, resend);
  await page.keyboard.press("Escape");
  await expect(sendAgain).toBeFocused();
  await page.screenshot({ path: `${SHOTS}/needs-review-1440.png`, fullPage: true });
  await axe(page, "needs-you");
  await page.emulateMedia({ colorScheme: "dark" });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${SHOTS}/dark-needs-you-${width}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  let retries = 0;
  await page.route(
    (url) => url.pathname.endsWith("/retry"),
    async (route) => {
      retries += 1;
      await route.continue();
    },
  );
  await sendAgain.click();
  const retryAction = await page.locator("dialog[open] form").getAttribute("action");
  const busy = await page.evaluate(() => {
    const form = document.querySelector("dialog[open] form");
    if (!(form instanceof HTMLFormElement)) return null;
    form.requestSubmit();
    form.requestSubmit();
    const button = form.querySelector("button.danger");
    return {
      aria: button?.getAttribute("aria-busy") ?? "",
      text: button?.textContent ?? "",
    };
  });
  expect(busy).toEqual({
    aria: "true",
    text: "Sending…",
  });
  await expect(page.getByText("That post is queued.")).toBeVisible();
  expect(retries).toBe(1);
  if (retryAction) {
    await page.goto(retryAction.replace(/\/retry$/, "/review"));
    await page.getByRole("button", { name: "Unschedule" }).click();
    await expect(page.getByText("Unscheduled.")).toBeVisible();
  }
});

test("the pause control is in the bar and the open dialog passes axe", async ({ page }) => {
  await connect(page);
  for (const path of ["/", "/queue", "/history", "/compose"]) {
    await page.goto(path);
    await expect(page.locator(".posting-bar #open-pause")).toBeVisible();
    await expect(page.locator("main #open-pause")).toHaveCount(0);
  }
  await page.goto("/settings");
  await expect(
    page.getByText(/Posting is on\. Scheduled posts go out at their time/),
  ).toHaveCount(1);
  const trigger = page.locator("#open-pause");
  for (const width of [375, 768, 1440] as const) {
    await page.setViewportSize({ width, height: width === 375 ? 800 : 900 });
    await page.goto("/");
    const box = await trigger.boundingBox();
    const bar = await page.locator(".posting-bar").boundingBox();
    const state = await page.locator("#posting-state").boundingBox();
    if (!box || !bar || !state) throw new Error("posting bar is not laid out");
    expect(box.height).toBeGreaterThanOrEqual(44);
    const style = await trigger.evaluate((node) => {
      const css = getComputedStyle(node);
      return { border: css.borderTopWidth, color: css.color, borderColor: css.borderTopColor, background: css.backgroundColor };
    });
    expect(style).toEqual({
      border: "2px",
      color: "rgb(243, 239, 228)",
      borderColor: "rgb(243, 239, 228)",
      background: "rgba(0, 0, 0, 0)",
    });
    if (width === 375) {
      expect(box.y).toBeGreaterThanOrEqual(state.y + state.height - 1);
    } else {
      expect(bar.x + bar.width - (box.x + box.width)).toBeLessThanOrEqual(32);
      expect(box.x).toBeGreaterThanOrEqual(state.x + state.width - 1);
      expect(Math.abs(box.y - state.y)).toBeLessThan(state.height);
    }
    await axe(page, `pr3-trigger-${width}`, ".posting-bar");
    if (width === 768) continue;
    await page.screenshot({ path: `${MEDIA}/pr3-trigger-${width}-default.png` });
    await trigger.hover();
    await expect(trigger).toHaveCSS("background-color", "rgb(243, 239, 228)");
    await page.screenshot({ path: `${MEDIA}/pr3-trigger-${width}-hover.png` });
    await page.mouse.move(0, 0);
    await page.reload();
    await trigger.focus();
    await expect(trigger).toHaveCSS("outline-style", "solid");
    await page.screenshot({ path: `${MEDIA}/pr3-trigger-${width}-focus.png` });
  }
  await page.emulateMedia({ colorScheme: "dark" });
  for (const width of [375, 1440] as const) {
    await page.setViewportSize({ width, height: width === 375 ? 800 : 900 });
    await page.goto("/");
    await axe(page, `pr3-dark-bar-${width}`, ".posting-bar");
    await page.screenshot({ path: `${MEDIA}/pr3-dark-bar-${width}.png` });
    await trigger.click();
    await expect(page.locator("#close-pause")).toBeFocused();
    await axe(page, `pr3-dark-dialog-${width}`, "#pause-dialog");
    await page.screenshot({ path: `${MEDIA}/pr3-dark-dialog-${width}.png` });
    await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("#pause-dialog");
  await expect(dialog).toHaveJSProperty("open", true);
  await expect(page.locator("#close-pause")).toBeFocused();
  await expect(page.locator("#close-pause")).toHaveCSS("outline-style", "solid");
  await page.screenshot({ path: `${MEDIA}/pr3-dialog-keyboard-focus-1440.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveJSProperty("open", false);
  await expect(trigger).toBeFocused();
  await page.screenshot({ path: `${MEDIA}/pr3-dialog-escape-focus-1440.png` });
  await trigger.click();
  await expect(dialog).toHaveJSProperty("open", true);
  await expect(page.locator("#close-pause")).toBeFocused();
  await expect(page.locator("#pause-warning")).toHaveText(
    "A post that's already sending may still go out. Nothing else will post after that. Only whoever runs this app can turn posting back on.",
  );
  for (const width of [375, 768, 1440] as const) {
    await page.setViewportSize({ width, height: width === 375 ? 800 : 900 });
    await expect(dialog).toHaveJSProperty("open", true);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
    await axe(page, `pause-dialog-${width}`, "#pause-dialog");
    await page.screenshot({
      path: `${MEDIA}/pr3-pause-dialog-${width}.png`,
      fullPage: true,
    });
  }
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    let light = 0;
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const alpha = await backdropAlpha(page);
      if (scheme === "light") {
        light = alpha;
        expect(alpha).toBeCloseTo(0.4, 2);
      } else {
        expect(alpha).toBeGreaterThan(light);
        expect(alpha).toBeGreaterThanOrEqual(0.55);
      }
      await axe(page, `polish-dialog-${width}-${scheme}`);
      await page.screenshot({
        path: `${MEDIA}/polish-dialog-${width}-${scheme}.png`,
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("#close-pause")).toBeFocused();
  await cycleDialogFocus(page, dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveJSProperty("open", false);
  await expect(page.locator("#open-pause")).toBeFocused();
});

test("a 500 from X says we don't know if it went out", async ({ page }) => {
  await connect(page);
  await fetch("http://127.0.0.1:9099/__control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tweetStatus: 500 }),
  });
  await page.goto("/compose");
  await page.locator("#text-0").fill("Unknown outcome post.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("link", { name: "Review and approve" }).click();
  await page.getByRole("button", { name: "Approve post" }).click();
  const slot = upcomingSlot();
  await page.locator("#schedule-date").fill(slot.date);
  await page.locator("#schedule-time").fill(slot.time);
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText("Scheduled.")).toBeVisible();
  const csrf = await page.locator("input[name=csrf]").first().inputValue();
  const jwt = await sign({ email: "you@example.com" });
  const dispatched = await dispatchAt(page, csrf, jwt, slot.utc + 1000);
  expect(dispatched.ok()).toBe(true);
  await page.goto("/history");
  const entry = page.locator(".history > li", { hasText: "Unknown outcome post." });
  await expect(
    entry.getByRole("heading", {
      name: "We don't know if this post went out. Check X before you send it again.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(entry.getByText(/timed out/)).toHaveCount(0);
  await expect(
    entry.getByText("Wait until the last attempt has finished, then check X."),
  ).toHaveCount(0);
  const postLink = entry.getByRole("textbox", { name: "Post link" });
  const postedButton = entry.getByRole("button", {
    name: "It posted (paste its link)",
  });
  await expect(postLink).toBeVisible();
  await expect(postLink).toHaveAccessibleName("Post link");
  await expect(postedButton).toBeVisible();
  await expect(postedButton).toHaveAccessibleName("It posted (paste its link)");
  await expect(entry.getByText("It posted. Paste its link.")).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 800 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await axe(page, `pr3-unknown-375-${scheme}`);
    await page.screenshot({ path: `${MEDIA}/pr3-unknown-375-${scheme}.png`, fullPage: true });
  }
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await axe(page, `followup-unknown-${width}-${scheme}`, undefined, WCAG);
      await page.screenshot({
        path: `${MEDIA}/followup-unknown-${width}-${scheme}.png`,
        fullPage: true,
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await postLink.focus();
  await expect(postLink).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(postedButton).toBeFocused();
});

test("a failed post and a missed post sit with needs-you on the dashboard", async ({ page }) => {
  await connect(page);
  await fetch("http://127.0.0.1:9099/__control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tweetStatus: 402 }),
  });
  await page.goto("/compose");
  await page.locator("#text-0").fill("This one fails because credits are empty.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("link", { name: "Review and approve" }).click();
  await page.getByRole("button", { name: "Approve post" }).click();
  const failedSlot = upcomingSlot();
  await page.locator("#schedule-date").fill(failedSlot.date);
  await page.locator("#schedule-time").fill(failedSlot.time);
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText("Scheduled.")).toBeVisible();
  const csrf = await page.locator("input[name=csrf]").first().inputValue();
  const jwt = await sign({ email: "you@example.com" });
  const failed = await dispatchAt(page, csrf, jwt, failedSlot.utc + 1000);
  expect(failed.ok()).toBe(true);
  await fetch("http://127.0.0.1:9099/__control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tweetStatus: 0, failOnTweet: 0 }),
  });
  await page.goto("/history");
  await expect(
    page.getByRole("heading", { name: "X API credits are empty.", exact: true }),
  ).toHaveCount(1);
  await page.goto("/settings");
  await expect(page.locator("#posting-state")).toHaveClass(/pill-on/);
  await expect(page.locator(".posting-bar #open-pause")).toBeVisible();
  await expect(page.locator("main #open-pause")).toHaveCount(0);
  await page.locator("#open-pause").click();
  await expect(page.locator("#close-pause")).toBeFocused();
  await cycleDialogFocus(page, page.locator("#pause-dialog"));
  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-dialog")).toHaveJSProperty("open", false);
  await expect(page.locator("#open-pause")).toBeFocused();
  await page.locator("#open-pause").click();
  await page
    .locator("#pause-dialog")
    .getByRole("button", { name: "Pause all posting" })
    .click();
  await expect(page.locator("#posting-state")).toHaveText(
    "Posting is paused. Nothing will go out. Only whoever runs this app can turn posting back on.",
  );
  await expect(page.locator("#posting-state")).toHaveClass(/pill-paused/);
  await expect(page.locator("#open-pause")).toHaveCount(0);
  for (const path of ["/", "/queue", "/history", "/compose"]) {
    await page.goto(path);
    await expect(page.locator(".posting-bar #open-pause")).toHaveCount(0);
  }
  await page.goto("/compose");
  await page.locator("#text-0").fill("This one was due while posting was paused.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("link", { name: "Review and approve" }).click();
  await page.getByRole("button", { name: "Approve post" }).click();
  const missedSlot = upcomingSlot(3, 11, 0);
  await page.locator("#schedule-date").fill(missedSlot.date);
  await page.locator("#schedule-time").fill(missedSlot.time);
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText("Scheduled.")).toBeVisible();
  const csrf2 = await page.locator("input[name=csrf]").first().inputValue();
  const missed = await dispatchAt(page, csrf2, jwt, missedSlot.utc + 1000);
  expect(missed.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByText("Failed", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Missed", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: /^Needs you \d+/ }),
  ).toBeVisible();
  await expect(page.getByText(/post needs you|posts need you/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dashboard-needs-failed-missed-1440.png`, fullPage: true });
  await axe(page, "dashboard-needs-failed-missed");
});

test("paused and empty-credit banners stay separated", async ({ page }) => {
  await connect(page);
  await fetch("http://127.0.0.1:9099/__control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tweetStatus: 402 }),
  });
  await page.goto("/compose");
  await page.locator("#text-0").fill("Credits banner gap.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("link", { name: "Review and approve" }).click();
  await page.getByRole("button", { name: "Approve post" }).click();
  const slot = upcomingSlot();
  await page.locator("#schedule-date").fill(slot.date);
  await page.locator("#schedule-time").fill(slot.time);
  await page.getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText("Scheduled.")).toBeVisible();
  const csrf = await page.locator("meta[name=csrf]").getAttribute("content");
  const jwt = await sign({ email: "you@example.com" });
  const failed = await dispatchAt(page, csrf ?? "", jwt, slot.utc + 1000);
  expect(failed.ok()).toBe(true);
  await pausePosting(page);
  const banner = page.locator("body > p.banner", {
    hasText: "X API credits are empty",
  });
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ width, height });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/queue");
      await expect(page.locator("#posting-state")).toHaveClass(/pill-paused/);
      await expect(banner).toBeVisible();
      const pausedBox = await page.locator("#posting-state").boundingBox();
      const bannerBox = await banner.boundingBox();
      if (!pausedBox || !bannerBox) throw new Error("banners are not laid out");
      const gap = bannerBox.y - (pausedBox.y + pausedBox.height);
      expect(gap).toBeGreaterThanOrEqual(8);
      expect(Math.abs(bannerBox.width - pausedBox.width)).toBeLessThanOrEqual(1);
      const seam = await page.evaluate((midY) => {
        const hit = document.elementFromPoint(12, midY);
        const credit = document.querySelector("p.banner-credits");
        const paused = document.querySelector("#posting-state");
        if (!hit || !credit || !paused) return null;
        const paint = (node: Element) => getComputedStyle(node).backgroundColor;
        return {
          insideCredit: credit.contains(hit),
          insidePaused: paused.contains(hit),
          hit: paint(hit),
          page: paint(document.body),
          credit: paint(credit),
        };
      }, pausedBox.y + pausedBox.height + 4);
      if (!seam) throw new Error("the gap between the banners is not laid out");
      expect(seam.insideCredit).toBe(false);
      expect(seam.insidePaused).toBe(false);
      expect(seam.hit).toBe(seam.page);
      expect(seam.hit).not.toBe(seam.credit);
      const edges = await banner.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          top: style.borderTopWidth,
          right: style.borderRightWidth,
          bottom: style.borderBottomWidth,
          left: style.borderLeftWidth,
          color: style.borderTopColor,
        };
      });
      const pausedEdge = await page.locator("#posting-state").evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          width: style.borderTopWidth,
          color: style.borderTopColor,
        };
      });
      expect(pausedEdge.width).toBe("2px");
      expect(edges.top).toBe(pausedEdge.width);
      expect(edges.right).toBe(pausedEdge.width);
      expect(edges.bottom).toBe(pausedEdge.width);
      expect(edges.left).toBe(pausedEdge.width);
      expect(edges.color).toBe(pausedEdge.color);
      await axe(page, `followup-banners-${width}-${scheme}`, undefined, WCAG);
      await page.screenshot({
        path: `${MEDIA}/followup-banners-${width}-${scheme}.png`,
        fullPage: true,
      });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
});

test("paused posting shows the paused bar and no pause control on every view", async ({ page }) => {
  await connect(page);
  await pausePosting(page);
  const shots: Array<[string, number, string]> = [
    ["/", 375, "pr3-paused-home-375"],
    ["/", 1440, "pr3-paused-home-1440"],
    ["/queue", 1440, "pr3-paused-queue-1440"],
    ["/history", 1440, "pr3-paused-history-1440"],
    ["/compose", 1440, "pr3-paused-compose-1440"],
    ["/settings", 375, "pr3-paused-settings-375"],
    ["/settings", 1440, "pr3-paused-settings-1440"],
  ];
  for (const [path, width, name] of shots) {
    await page.setViewportSize({ width, height: width === 375 ? 800 : 900 });
    await page.goto(path);
    await expect(page.locator("#posting-state")).toHaveClass(/pill-paused/);
    await expect(page.locator("#posting-state")).toHaveText(
      "Posting is paused. Nothing will go out. Only whoever runs this app can turn posting back on.",
    );
    await expect(page.locator("#open-pause")).toHaveCount(0);
    await axe(page, name);
    await page.screenshot({ path: `${MEDIA}/${name}.png`, fullPage: true });
  }
});
