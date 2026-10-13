import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`update channels ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 } });
    test("selection persists and clears the previous offer", async ({
      page,
    }, testInfo) => {
      const state = await operationsFixture(page);
      const en = locale === "en-GB";
      await page.goto("/settings/updates");
      const select = page.getByRole("combobox", {
        name: en ? "Update channel" : "Updatekanal",
        exact: true,
      });
      await expect(select).toHaveValue("stable");
      await page
        .getByRole("button", {
          name: en ? "Check for updates" : "Nach Updates suchen",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "1.1.0", exact: true }),
      ).toBeVisible();
      await select.selectOption("preview");
      await expect(select).toHaveValue("preview");
      await expect(page.getByRole("heading", { name: "1.1.0", exact: true })).toHaveCount(
        0,
      );
      expect(
        state.calls.some(
          (call) =>
            call.path.endsWith("/releases/channel") &&
            call.method === "PUT" &&
            call.body.updateChannel === "preview",
        ),
      ).toBe(true);
      await page.reload();
      await expect(select).toHaveValue("preview");
      await expect(
        page.getByText(
          en
            ? /Preview includes release candidates/
            : /Preview enthält Release Candidates/,
        ),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("update-channel-preview.png"),
        fullPage: true,
      });
      state.fail = "/operations/releases/channel";
      await select.selectOption("stable");
      await expect(page.getByText("Fixture conflict", { exact: true })).toBeVisible();
      await expect(select).toHaveValue("preview");
      state.fail = "";
      await select.selectOption("stable");
      await expect(select).toHaveValue("stable");
    });
    test("custom sources explain why the channel selection is managed", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      state.releases.updateChannelManaged = true;
      state.releases.channel = "https://custom.example/releases/";
      await page.goto("/settings/updates");
      await expect(page.getByRole("combobox")).toBeDisabled();
      await expect(
        page.getByText(
          locale === "en-GB"
            ? /A custom update source is configured/
            : /Eine eigene Update-Quelle ist eingerichtet/,
        ),
      ).toBeVisible();
      await expect(
        page.getByText(
          `${locale === "en-GB" ? "Update source" : "Update-Quelle"}: https://custom.example/releases/`,
        ),
      ).toBeVisible();
    });
    test("source checkouts cannot change the update channel", async ({ page }) => {
      const state = await operationsFixture(page);
      state.releases.supported = false;
      await page.goto("/settings/updates");
      await expect(page.getByRole("combobox")).toBeDisabled();
    });
    test("pre-releases are marked and preview explains the risk", async ({
      page,
    }, testInfo) => {
      const state = await operationsFixture(page);
      const en = locale === "en-GB";
      const badge = en ? "Pre-release" : "Vorabversion";
      state.releases.updateChannel = "preview";
      state.releases.staged = [{ id: "staged-rc", version: "1.2.0-rc.1" }];
      state.checkVersion = "1.3.0-rc.2";
      await page.goto("/settings/updates");
      await expect(
        page.getByText(
          en
            ? /Release candidates can contain unfinished changes\. .*rolling back to the previous stable version can be impossible.*Settings → Backups/
            : /Release Candidates können unfertige Änderungen enthalten\. .*Einstellungen → Sicherungen/,
        ),
      ).toBeVisible();
      await page
        .getByRole("button", {
          name: en ? "Check for updates" : "Nach Updates suchen",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: `1.3.0-rc.2 ${badge}`, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: `${en ? "Staged" : "Vorbereitet"}: 1.2.0-rc.1 ${badge}`,
        }),
      ).toBeVisible();
      for (const viewport of [
        { width: 390, height: 844, name: "mobile" },
        { width: 1280, height: 900, name: "desktop" },
      ]) {
        await page.setViewportSize(viewport);
        // Let the layout settle at the new size before measuring and capturing it.
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))),
        );
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(`update-channel-prerelease-${viewport.name}.png`),
          fullPage: viewport.name === "mobile",
        });
      }
      await page
        .getByRole("combobox", { name: en ? "Update channel" : "Updatekanal" })
        .selectOption("stable");
      await expect(
        page.getByText(
          en
            ? /Pre-releases that are already staged can still be activated/
            : /Bereits vorbereitete Vorabversionen lassen sich/,
        ),
      ).toBeVisible();
      await expect(page.locator(".release-badge")).toHaveText([badge]);
    });
  });
}
