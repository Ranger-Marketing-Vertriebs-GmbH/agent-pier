import { test, expect } from "../helpers/browser-test.js";

// Settings › Operations › Development › Components: the split layout and drop zone
// specimens (docs/ui-guide.md#page-structure).
for (const [locale, label, status] of [
  ["de-DE", "Größe der Bereiche ändern", /Links abgelegt/],
  ["en-GB", "Resize panes", /Dropped on the left/],
]) {
  test.describe(`split primitives ${locale}`, () => {
    test.use({ locale, viewport: { width: 1440, height: 1000 } });

    test("the divider is named and resizes with the arrow keys", async ({ page }) => {
      await page.goto("/settings/components");
      const specimen = page.locator(".gallery-split");
      await expect(specimen.locator(".split-pane")).toHaveCount(3);
      const divider = specimen.getByRole("separator", { name: label }).first();
      await expect(divider).toHaveAttribute("aria-orientation", "vertical");
      await expect(divider).toHaveAttribute("aria-valuenow", "50");
      const before = await specimen.locator(".split-pane").first().boundingBox();
      await divider.focus();
      await page.keyboard.press("ArrowRight");
      await expect(divider).toHaveAttribute("aria-valuenow", "55");
      const after = await specimen.locator(".split-pane").first().boundingBox();
      expect(after.width).toBeGreaterThan(before.width);
    });

    test("dragging the divider resizes once and stops at the bounds", async ({
      page,
    }) => {
      await page.goto("/settings/components");
      const specimen = page.locator(".gallery-split");
      const divider = specimen.getByRole("separator", { name: label }).first();
      await divider.scrollIntoViewIfNeeded();
      const box = await divider.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 600, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(divider).toHaveAttribute("aria-valuenow", "85");
    });

    test("the drop zone follows a pane drag and reports the dropped side", async ({
      page,
    }) => {
      await page.goto("/settings/components");
      const zone = page.getByTestId("drop-zone-specimen");
      const carrier = await page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.setData("application/x-agentpier-pane", "x");
        return data;
      });
      const box = await zone.boundingBox();
      const point = {
        clientX: box.x + box.width * 0.05,
        clientY: box.y + box.height / 2,
      };
      await zone.dispatchEvent("dragover", { dataTransfer: carrier, ...point });
      const overlay = zone.locator(".drop-zone-overlay");
      await expect(overlay).toHaveAttribute("data-side", "left");
      const zoneBox = await overlay.boundingBox();
      expect(Math.abs(zoneBox.width - box.width / 2)).toBeLessThan(2);
      await zone.dispatchEvent("drop", { dataTransfer: carrier, ...point });
      await expect(overlay).toHaveCount(0);
      await expect(zone.getByRole("status")).toHaveText(status);
    });

    test("foreign drags leave the drop zone alone", async ({ page }) => {
      await page.goto("/settings/components");
      const zone = page.getByTestId("drop-zone-specimen");
      const carrier = await page.evaluateHandle(() => {
        const data = new DataTransfer();
        data.setData("text/plain", "x");
        return data;
      });
      await zone.dispatchEvent("dragover", { dataTransfer: carrier });
      await expect(zone.locator(".drop-zone-overlay")).toHaveCount(0);
    });
  });
}
