import { test, expect } from "../helpers/browser-test.js";

// Settings › Operations › Development › Components: the DockedPanel specimen
// (docs/ui-guide.md#page-structure). The panel is not modal: it sits beside the
// page's content, which stays usable, and closes with its own button.
for (const [locale, names] of [
  [
    "en-GB",
    { title: "Docked panel", close: "Close docked panel", open: "Open docked panel" },
  ],
  [
    "de-DE",
    {
      title: "Angedocktes Panel",
      close: "Angedocktes Panel schließen",
      open: "Angedocktes Panel öffnen",
    },
  ],
]) {
  test.describe(`docked panel ${locale}`, () => {
    test.use({ locale, viewport: { width: 1440, height: 1000 } });

    test("renders beside its content and closes with its button", async ({ page }) => {
      await page.goto("/settings/components");
      const specimen = page.locator(".gallery-docked");
      await specimen.scrollIntoViewIfNeeded();
      const panel = specimen.getByRole("complementary", { name: names.title });
      await expect(panel).toBeVisible();
      // Not a modal dialog: nothing blocks the page behind it.
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      const content = await specimen.locator(".gallery-docked-content").boundingBox();
      const box = await panel.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(content.x + content.width - 1);
      expect(Math.abs(box.y - content.y)).toBeLessThanOrEqual(1);
      // Docked at the right edge of its parent (inside the specimen's 1px border).
      const frame = await specimen.boundingBox();
      expect(Math.abs(frame.x + frame.width - (box.x + box.width))).toBeLessThanOrEqual(
        2,
      );

      await panel.getByRole("button", { name: names.close }).click();
      await expect(panel).toHaveCount(0);
      await specimen.getByRole("button", { name: names.open }).click();
      await expect(
        specimen.getByRole("complementary", { name: names.title }),
      ).toBeVisible();
    });
  });
}
