import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { ARTIFACTS, SHOTS } from "./artifacts";

test("drafts and composer in WebKit iPhone emulation", async ({ page }) => {
  const response = await fetch("http://127.0.0.1:9099/__sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "you@example.com" }),
  });
  await page.context().setExtraHTTPHeaders({
    "cf-access-jwt-assertion": await response.text(),
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Drafts", level: 1 })).toBeVisible();
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({
    path: `${SHOTS}/iphone-emulation-drafts.png`,
    fullPage: true,
  });
  await page.goto("/compose");
  await expect(page.getByRole("heading", { name: "New draft" })).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/iphone-emulation-composer.png`,
    fullPage: true,
  });
  await writeFile(
    `${ARTIFACTS}/webkit-iphone-emulation.txt`,
    "Playwright WebKit emulating an iPhone 13 (device descriptor, not a physical phone). This is emulation, not a real device.\n",
  );
});
