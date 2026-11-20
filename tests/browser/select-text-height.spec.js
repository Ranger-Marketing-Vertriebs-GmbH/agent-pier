import { test, expect } from "../helpers/browser-test.js";

// Select text keeps its descenders: no select is shorter than its font needs
// (AGENTPIER-431, AGENTPIER-399).
for (const width of [320, 1440])
  test(`selects fit their text at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings/components");
    await expect(page.locator("select").first()).toBeVisible();
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll("select")]
        .filter((select) => select.getClientRects().length)
        .flatMap((select) => {
          const style = getComputedStyle(select);
          const content =
            select.clientHeight -
            parseFloat(style.paddingTop) -
            parseFloat(style.paddingBottom);
          return content + 0.5 < parseFloat(style.fontSize) * 1.15
            ? [`${select.getAttribute("aria-label") || select.id}: ${content}`]
            : [];
        }),
    );
    expect(clipped).toEqual([]);
  });
