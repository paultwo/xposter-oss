import { expect, type Locator, type Page } from "@playwright/test";

// Visible controls only. Hidden and disabled inputs are not stops.
async function focusStops(dialog: Locator): Promise<string[]> {
  return dialog.evaluate((node) => {
    return [...node.querySelectorAll("a[href], button, input, select, textarea")]
      .filter((entry) => {
        if (!(entry instanceof HTMLElement)) return false;
        if (entry.closest("[hidden]")) return false;
        if (entry instanceof HTMLInputElement && entry.type === "hidden") return false;
        if (entry.hasAttribute("disabled")) return false;
        if ("disabled" in entry && entry.disabled === true) return false;
        return true;
      })
      .map((entry) => (entry.textContent ?? "").replace(/\s+/g, " ").trim());
  });
}

async function hiddenInputFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLInputElement && active.type === "hidden";
  });
}

export async function cycleDialogFocus(page: Page, dialog: Locator): Promise<void> {
  const names = await focusStops(dialog);
  expect(names.length).toBeGreaterThan(0);
  expect(names[names.length - 1]).toBe("Cancel");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();

  let index = names.length - 1;
  for (let step = 0; step < names.length; step += 1) {
    await page.keyboard.press("Tab");
    index = (index + 1) % names.length;
    await expect(
      dialog.getByRole("button", { name: names[index] ?? "", exact: true }),
    ).toBeFocused();
    expect(await hiddenInputFocused(page)).toBe(false);
  }
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();

  for (let step = 0; step < names.length; step += 1) {
    await page.keyboard.press("Shift+Tab");
    index = (index - 1 + names.length) % names.length;
    await expect(
      dialog.getByRole("button", { name: names[index] ?? "", exact: true }),
    ).toBeFocused();
    expect(await hiddenInputFocused(page)).toBe(false);
  }
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
}
