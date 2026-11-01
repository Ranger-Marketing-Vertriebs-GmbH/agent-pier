import { test, expect } from "../helpers/browser-test.js";

// AGENTPIER-339: an installation without pipeline runs showed the start page's
// Pipelines card as skeleton rows forever. The card and the phone tile wait only for
// their own run sources, never for the other menu-hint sources (here the connection
// problems, which do not answer), and a run listing that fails says so.
// The isolated test server has no runs and no pipelines.

const layouts = [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
];
const copy = {
  "en-GB": { empty: "No run is active or waiting.", tile: "All runs" },
  "de-DE": { empty: "Kein Lauf ist aktiv oder wartet.", tile: "Alle Läufe" },
};
const unavailable = {
  "en-GB": "Runs could not be loaded.",
  "de-DE": "Die Läufe konnten nicht geladen werden.",
};

// Holds every read of `pattern` unanswered for the rest of the test.
const never = (page, pattern) => page.route(pattern, () => new Promise(() => {}));

for (const locale of ["en-GB", "de-DE"])
  test.describe(locale, () => {
    test.use({ locale });
    for (const [name, viewport] of layouts) {
      test(`no runs show the empty text, not skeletons (${name})`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await never(page, "**/api/connections/problems");
        await page.goto("/");
        if (name === "desktop") {
          const card = page.locator(".start-pipelines");
          await expect(card).toContainText(copy[locale].empty);
          await expect(card).not.toHaveAttribute("aria-busy");
          await expect(card.locator(".skeleton")).toHaveCount(0);
        } else {
          const tile = page.locator(".start-tiles > :first-child");
          await expect(tile.locator("small")).toHaveText(copy[locale].tile);
          await expect(tile.locator("[aria-busy='true']")).toHaveCount(0);
          await expect(tile.locator(".skeleton")).toHaveCount(0);
        }
      });

      test(`failed run listings say so instead of loading (${name})`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        for (const pattern of ["**/api/pipeline-runs?*", "**/api/pipeline-run-counts*"])
          await page.route(pattern, (route) =>
            route.fulfill({ status: 500, json: { error: "boom" } }),
          );
        await page.goto("/");
        const place =
          name === "desktop"
            ? page.locator(".start-pipelines")
            : page.locator(".start-tiles > :first-child");
        await expect(place).toContainText(unavailable[locale]);
        await expect(place.locator(".skeleton")).toHaveCount(0);
        await expect(place.locator("[aria-busy='true']")).toHaveCount(0);
      });
    }
  });
