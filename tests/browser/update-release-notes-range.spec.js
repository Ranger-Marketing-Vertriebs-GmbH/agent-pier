import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";

const tag = (version) =>
  `https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/tag/v${version}`;
const notes = {
  "1.1.0": "## Hotfix\n\n- Restore the session list after reconnecting.",
  "1.0.2": "## Fixes\n\n- Keep queued messages after a reload.",
  "1.0.1": "## Chat improvements\n\n- **Multi-question dialogs** show every question.",
};

test.describe("update release notes across versions", () => {
  test.use({ locale: "en-GB", viewport: { width: 900, height: 1000 } });
  test("every version since the installed one is listed newest first", async ({
    page,
  }) => {
    await operationsFixture(page);
    const requests = [];
    await page.route(/\/api\/operations\/releases\/notes(?:\/|\?)/, (route) => {
      requests.push(route.request().url());
      return route.fulfill({
        json: {
          from: "1.0.0",
          to: "1.1.0",
          releases: Object.entries(notes).map(([version, body], index) => ({
            version,
            body,
            url: tag(version),
            publishedAt: `2026-09-${String(20 - index * 5).padStart(2, "0")}T10:00:00Z`,
          })),
          truncated: false,
          url: "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases",
        },
      });
    });
    await page.goto("/settings/updates");
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    const region = page.getByRole("region", { name: "What’s new since version 1.0.0" });
    const summaries = region.locator("summary");
    await expect(summaries).toHaveText([
      /^1\.1\.0 · published Sep 20, 2026$/,
      /^1\.0\.2 · published Sep 15, 2026$/,
      /^1\.0\.1 · published Sep 10, 2026$/,
    ]);
    const sections = region.locator("details");
    await expect(sections.nth(0)).toHaveAttribute("open", "");
    await expect(sections.nth(1)).not.toHaveAttribute("open");
    await expect(
      region.getByText("Restore the session list after reconnecting."),
    ).toBeVisible();
    await expect(region.getByText("Keep queued messages after a reload.")).toBeHidden();
    await expect(
      region.getByRole("link", { name: "View release on GitHub" }).first(),
    ).toHaveAttribute("href", tag("1.1.0"));

    await region.screenshot({ path: "docs/screenshots/release-notes-range.png" });

    await summaries.nth(1).focus();
    await page.keyboard.press("Enter");
    await expect(sections.nth(1)).toHaveAttribute("open", "");
    await expect(region.getByText("Keep queued messages after a reload.")).toBeVisible();

    await expect(region.locator(".release-notes-overflow")).toHaveCount(0);
    expect(requests).toEqual([
      expect.stringMatching(
        /\/api\/operations\/releases\/notes\?from=1\.0\.0&to=1\.1\.0$/,
      ),
    ]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });
  test("more than 20 versions point to the full release list", async ({ page }) => {
    await operationsFixture(page);
    await page.route(/\/api\/operations\/releases\/notes\?/, (route) =>
      route.fulfill({
        json: {
          from: "1.0.0",
          to: "1.1.0",
          releases: Array.from({ length: 20 }, (_, index) => ({
            version: index ? `1.0.${21 - index}` : "1.1.0",
            body: `- Change ${index}`,
            url: tag(index ? `1.0.${21 - index}` : "1.1.0"),
            publishedAt: "2026-09-20T10:00:00Z",
          })),
          truncated: true,
          url: "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases",
        },
      }),
    );
    await page.goto("/settings/updates");
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    const region = page.getByRole("region", { name: "What’s new since version 1.0.0" });
    await expect(region.locator("details")).toHaveCount(20);
    await expect(region.locator("details[open]")).toHaveCount(1);
    await expect(
      region.getByText("Only the 20 most recent versions are shown."),
    ).toBeVisible();
    await expect(
      region.getByRole("link", { name: "View all releases on GitHub", exact: true }),
    ).toHaveAttribute(
      "href",
      "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases",
    );
  });
  test("a partially loaded list is not presented as the version cap", async ({
    page,
  }) => {
    await operationsFixture(page);
    await page.route(/\/api\/operations\/releases\/notes\?/, (route) =>
      route.fulfill({
        json: {
          from: "1.0.0",
          to: "1.1.0",
          releases: ["1.1.0", "1.0.5"].map((version) => ({
            version,
            body: `- Change in ${version}`,
            url: tag(version),
            publishedAt: "2026-09-20T10:00:00Z",
          })),
          truncated: false,
          incomplete: true,
          url: "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases",
        },
      }),
    );
    await page.goto("/settings/updates");
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    const region = page.getByRole("region", { name: "What’s new since version 1.0.0" });
    await expect(region.locator("details")).toHaveCount(2);
    await expect(
      region.getByText("Some release notes could not be loaded."),
    ).toBeVisible();
    await expect(region.getByText(/most recent versions are shown/)).toHaveCount(0);
    await expect(
      region.getByRole("link", { name: "View all releases on GitHub", exact: true }),
    ).toHaveAttribute(
      "href",
      "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases",
    );
  });
});
