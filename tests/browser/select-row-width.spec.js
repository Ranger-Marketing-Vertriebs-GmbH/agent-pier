import { test, expect } from "../helpers/browser-test.js";

// A SelectRow with a long option keeps its label and stays inside its row
// (AGENTPIER-419: "For whom?" in New agent vanished beside a long user name).
for (const width of [320, 390, 1440])
  test(`a long SelectRow option ends in an ellipsis at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/components");
    const select = page.getByRole("combobox", { name: "Auswahl", exact: true });
    await expect(select).toBeVisible();
    await select.evaluate((element) => {
      element.options[element.selectedIndex].textContent =
        "Maximiliane Alexandra von Hohenzollern-Sigmaringen (maximiliane.alexandra@example.com)";
    });
    const row = select.locator(
      "xpath=ancestor::*[contains(concat(' ', @class, ' '), ' list-row ')][1]",
    );
    const label = row.locator(".list-row-label");
    const [rowBox, selectBox, labelBox] = await Promise.all([
      row.boundingBox(),
      select.boundingBox(),
      label.boundingBox(),
    ]);
    expect(selectBox.x + selectBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
    expect(labelBox.width).toBeGreaterThanOrEqual(Math.min(60, rowBox.width * 0.3));
    expect(selectBox.width).toBeLessThanOrEqual(rowBox.width * 0.6 + 1);
    const overflow = await page.evaluate(
      () => document.scrollingElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });
