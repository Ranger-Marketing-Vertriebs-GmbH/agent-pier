import { test, expect } from "@playwright/test";
import { fixture, createForm } from "./providers-fixture.js";

test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });

// iOS opens its native picker for a focused select and ends a tap by blurring the
// element focused during it, without a related target.
test("a tapped searchable select keeps its search focused on a phone", async ({
  page,
}) => {
  const controls = await fixture(page);
  await createForm(page, "opencode", controls);
  await page.getByLabel("API-Anbieter", { exact: true }).selectOption("openrouter");
  const model = page.getByLabel("Anbietermodell", { exact: true });
  await model.evaluate((select) => {
    window.selectFocused = false;
    select.addEventListener("focus", () => (window.selectFocused = true));
  });
  await model.tap();
  const search = page.getByRole("combobox", { name: "Modelle suchen", exact: true });
  await expect(search).toBeFocused();
  await search.evaluate((input) => input.blur());
  await expect(search).toBeVisible();
  await page.getByRole("option").filter({ hasText: "z-ai/glm-5.3" }).tap();
  await expect(model).toHaveValue("z-ai/glm-5.3");
  await expect(search).toHaveCount(0);
  await expect(model).not.toBeFocused();
  expect(await page.evaluate(() => window.selectFocused)).toBe(false);
});

test("a tap outside closes an open searchable select on a phone", async ({ page }) => {
  const controls = await fixture(page);
  await createForm(page, "opencode", controls);
  await page.getByLabel("API-Anbieter", { exact: true }).selectOption("openrouter");
  await page.getByLabel("Anbietermodell", { exact: true }).tap();
  const search = page.getByRole("combobox", { name: "Modelle suchen", exact: true });
  await expect(search).toBeVisible();
  await page.touchscreen.tap(8, 8);
  await expect(search).toHaveCount(0);
});
