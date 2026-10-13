import { test, expect } from "@playwright/test";
import { startSettingsHarness } from "../helpers/settings-pattern-harness.js";

test.describe.configure({ timeout: 90000 });
let harness;
test.beforeAll(async () => {
  harness = await startSettingsHarness();
});
test.afterAll(async () => {
  await harness?.close();
});
const open = (page, lang = "de") => page.goto(`${harness.url}?fixture=tabs&lang=${lang}`);

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("overflowing tabs fade at the edge and keep the active tab in view", async ({
    page,
  }) => {
    await open(page);
    const list = page.getByRole("tablist", { name: "Harness tabs" });
    await expect(list).toHaveClass(/can-scroll-right/);
    await expect(list).not.toHaveClass(/can-scroll-left/);
    await page.getByRole("tab", { name: "Profil" }).focus();
    await page.keyboard.press("End");
    const last = page.getByRole("tab", { name: "Benachrichtigungen" });
    await expect(last).toHaveAttribute("aria-selected", "true");
    await expect(last).toBeFocused();
    await expect(page.getByTestId("selected")).toHaveText("notifications");
    await expect(list).toHaveClass(/can-scroll-left/);
    await expect(list).not.toHaveClass(/can-scroll-right/);
    const row = await list.boundingBox();
    const tab = await last.boundingBox();
    expect(tab.x + tab.width).toBeLessThanOrEqual(row.x + row.width + 1);
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "Profil" })).toBeFocused();
    await expect(list).not.toHaveClass(/can-scroll-left/);
    await page.keyboard.press("ArrowLeft");
    await expect(last).toHaveAttribute("aria-selected", "true");
  });

  test("tab counts are small text inside the tab name", async ({ page }) => {
    await open(page);
    const tab = page.getByRole("tab", { name: /^Fähigkeiten/ });
    await expect(tab.locator("small")).toHaveText("3");
    const list = page.getByRole("tablist", { name: "Harness tabs" });
    expect(await list.evaluate((el) => el.getBoundingClientRect().height)).toBe(44);
  });

  test("run filter chips fade while more chips are hidden", async ({ page }) => {
    await open(page);
    const chips = page.getByRole("group", { name: "Status" });
    await expect(chips).toHaveClass(/can-scroll-right/);
    await chips.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(chips).toHaveClass(/can-scroll-left/);
    await expect(chips).not.toHaveClass(/can-scroll-right/);
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("hover arrows scroll an overflowing row and stay out of the tab order", async ({
    page,
  }) => {
    await open(page, "en");
    const list = page.getByRole("tablist", { name: "Harness tabs" });
    await expect(list).toHaveClass(/can-scroll-right/);
    const frame = page.locator(".underline-tabs-frame").first();
    const right = frame.locator(".underline-tabs-arrow.right");
    await expect(right).toBeHidden();
    await frame.hover();
    await expect(right).toBeVisible();
    await expect(right).toHaveAttribute("tabindex", "-1");
    await right.click();
    await expect.poll(() => list.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expect(list).toHaveClass(/can-scroll-left/);
  });
});
