import { test, expect } from "../helpers/browser-test.js";
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

// The on-screen keyboard shrinks only the visual viewport (web/lib/keyboard-inset.js):
// the options and their search stay in the part it leaves visible.
test("an open searchable select stays above the on-screen keyboard", async ({ page }) => {
  const controls = await fixture(page);
  await createForm(page, "opencode", controls);
  await page.getByLabel("API-Anbieter", { exact: true }).selectOption("openrouter");
  const model = page.getByLabel("Anbietermodell", { exact: true });
  // Where iOS puts a focused field: in the part of the page the keyboard leaves visible.
  await model.evaluate((select) => select.scrollIntoView({ block: "center" }));
  await model.tap();
  const search = page.getByRole("combobox", { name: "Modelle suchen", exact: true });
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("autocomplete", "off");
  await page.evaluate(() => {
    const viewport = window.visualViewport;
    Object.defineProperty(viewport, "height", { configurable: true, value: 464 });
    viewport.dispatchEvent(new Event("resize"));
  });
  const options = page.locator(".anchored-options");
  await expect
    .poll(async () => {
      const box = await options.boundingBox();
      return box.y >= 0 && box.y + box.height <= 464;
    })
    .toBe(true);
});
