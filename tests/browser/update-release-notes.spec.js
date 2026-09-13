import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`update release notes ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 } });
    test("notes render safely before staging and survive a staged-page reload", async ({
      page,
    }, testInfo) => {
      const en = locale === "en-GB";
      await operationsFixture(page);
      const requests = [];
      await page.route("**/api/operations/releases/notes/*", (route) => {
        requests.push(route.request().url());
        return route.fulfill({
          json: {
            version: "1.1.0",
            body: "## Fixes\n\n- **All questions** are shown.\n- Queue indicators are clearer.\n\n[Details](https://example.com/changes)\n\n[Unsafe](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n![Tracking](https://example.com/tracking.png)",
            url: "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/tag/v1.1.0",
          },
        });
      });
      await page.goto("/settings/updates");
      await page
        .getByRole("button", {
          name: en ? "Check for updates" : "Nach Updates suchen",
          exact: true,
        })
        .click();
      const notes = page.getByRole("region", {
        name: en ? "What’s new in this version" : "Neu in dieser Version",
      });
      await expect(notes.locator("strong")).toHaveText("All questions");
      await expect(notes.getByRole("listitem")).toHaveCount(2);
      await expect(
        notes.getByRole("link", { name: "Details", exact: true }),
      ).toHaveAttribute("target", "_blank");
      await expect(notes.locator('a[href^="javascript:"]')).toHaveCount(0);
      await expect(notes.locator("img, script")).toHaveCount(0);
      await expect(
        notes.getByRole("link", {
          name: en ? "View release on GitHub" : "Release auf GitHub ansehen",
        }),
      ).toHaveAttribute("href", /\/v1\.1\.0$/);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("update-release-notes-mobile.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", {
          name: en ? "Stage release" : "Version vorbereiten",
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/job=job-stage/);
      await page.reload();
      await expect(notes.locator("strong")).toHaveText("All questions");
      expect(requests.every((url) => url.endsWith("/notes/1.1.0"))).toBe(true);
    });
    test("slow or missing notes do not block staging", async ({ page }) => {
      const en = locale === "en-GB";
      await operationsFixture(page);
      let finish;
      const gate = new Promise((resolve) => {
        finish = resolve;
      });
      await page.route("**/api/operations/releases/notes/*", async (route) => {
        await gate;
        await route.fulfill({ status: 503, json: { error: "Unavailable" } });
      });
      await page.goto("/settings/updates");
      await page
        .getByRole("button", {
          name: en ? "Check for updates" : "Nach Updates suchen",
          exact: true,
        })
        .click();
      await expect(
        page.getByText(
          en ? "Loading release notes …" : "Versionshinweise werden geladen …",
          { exact: true },
        ),
      ).toBeVisible();
      await page
        .getByRole("button", {
          name: en ? "Stage release" : "Version vorbereiten",
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/job=job-stage/);
      finish();
      await expect(
        page.getByText(
          en
            ? "Release notes are currently unavailable. You can still update."
            : "Versionshinweise sind gerade nicht verfügbar. Das Update ist trotzdem möglich.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: en
            ? "Activate staged release: 1.1.0"
            : "Vorbereitete Version aktivieren: 1.1.0",
          exact: true,
        }),
      ).toBeEnabled();
    });
  });
}

test.describe("English update preview", () => {
  test.use({ locale: "en-GB", viewport: { width: 390, height: 844 } });
  test("release highlights are readable on mobile", async ({ page }, testInfo) => {
    await operationsFixture(page);
    await page.route("**/api/operations/releases/notes/*", (route) =>
      route.fulfill({
        json: {
          version: "1.1.0",
          body: "## Chat improvements\n\n- Show when messages are waiting in the CLI queue.\n- Answer every question in a multi-question dialog.\n- Keep question navigation visible on mobile.",
          url: "https://github.com/Ranger-Marketing-Vertriebs-GmbH/agent-pier/releases/tag/v1.1.0",
        },
      }),
    );
    await page.goto("/settings/updates");
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Chat improvements", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("release-notes-mobile.png"),
      fullPage: true,
    });
  });
});
