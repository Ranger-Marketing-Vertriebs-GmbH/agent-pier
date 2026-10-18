import { test, expect } from "@playwright/test";
import { settingsBar } from "../helpers/settings.js";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  const en = locale === "en-GB";
  const t = (german, english) => (en ? english : german);
  test.describe(`update channels ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 } });
    const radio = (page, name) => page.getByRole("radio", { name, exact: true });
    const stable = (page) => radio(page, t("Stable — Standard", "Stable — Default"));
    const preview = (page) =>
      radio(page, t("Preview — Vorabversionen", "Preview — Release candidates"));
    const save = (page) =>
      settingsBar(page)
        .getByRole("button", { name: t("Speichern", "Save"), exact: true })
        .click();

    test("selection persists and clears the previous offer", async ({
      page,
    }, testInfo) => {
      const state = await operationsFixture(page);
      await page.goto("/settings/updates");
      await expect(stable(page)).toBeChecked();
      await page
        .getByRole("button", {
          name: t("Nach Updates suchen", "Check for updates"),
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "1.1.0", exact: true }),
      ).toBeVisible();
      await preview(page).check();
      await save(page);
      await expect(preview(page)).toBeChecked();
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
      await expect(preview(page)).toBeChecked();
      await expect(
        page.getByText(
          t(/Preview enthält Release Candidates/, /Preview includes release candidates/),
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
      await stable(page).check();
      await save(page);
      await expect(page.getByText("Fixture conflict", { exact: true })).toBeVisible();
      await settingsBar(page)
        .getByRole("button", { name: t("Abbrechen", "Cancel"), exact: true })
        .click();
      await expect(preview(page)).toBeChecked();
      state.fail = "";
      await stable(page).check();
      await save(page);
      await expect(stable(page)).toBeChecked();
      await expect(settingsBar(page)).toHaveCount(0);
    });

    test("custom sources explain why the channel selection is managed", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      state.releases.updateChannelManaged = true;
      state.releases.channel = "https://custom.example/releases/";
      await page.goto("/settings/updates");
      const custom = radio(page, t("Eigene Update-Quelle", "Custom update source"));
      await expect(custom).toBeChecked();
      for (const row of [custom, stable(page), preview(page)])
        await expect(row).toBeDisabled();
      await expect(
        page.getByText(
          t(
            /Eine eigene Update-Quelle ist eingerichtet/,
            /A custom update source is configured/,
          ),
        ),
      ).toBeVisible();
      await expect(
        page.getByText(
          `${locale === "en-GB" ? "Update source" : "Update-Quelle"}: https://custom.example/releases/`,
        ),
      ).toBeVisible();
    });
    test("source checkouts explain why the channel selection is locked", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      state.releases.supported = false;
      await page.goto("/settings/updates");
      const reason = t(
        /Updatekanäle gelten nur für eine versionierte Installation/,
        /Update channels apply only to a versioned installation/,
      );
      await expect(page.getByText(reason)).toBeVisible();
      for (const row of [stable(page), preview(page)]) {
        await expect(row).toBeDisabled();
        await expect(row).toHaveAccessibleDescription(reason);
      }
    });
    test("an installed pre-release is marked next to the installed version", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      const en = locale === "en-GB";
      state.releases.current = "1.2.0-rc.1";
      await page.goto("/settings/updates");
      await expect(
        page.getByText(
          `${en ? "Installed version" : "Installierte Version"}: 1.2.0-rc.1 ${en ? "Pre-release" : "Vorabversion"}`,
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.locator(".release-badge")).toHaveCount(1);
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
            ? /Release candidates can contain unfinished changes\. .*rolling back to the previous stable version can be impossible.*Settings › Operations › Backups/
            : /Release Candidates können unfertige Änderungen enthalten\. .*Einstellungen › Betrieb › Sicherungen/,
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
      // Saving Stable clears the offered candidate; the staged pre-release stays.
      await stable(page).check();
      await save(page);
      await expect(settingsBar(page)).toHaveCount(0);
      await expect(
        page.getByText(
          en
            ? /Pre-releases that are already staged can still be activated/
            : /Bereits vorbereitete Vorabversionen lassen sich/,
        ),
      ).toBeVisible();
      await expect(page.locator(".release-badge")).toHaveText([badge]);
    });

    test("a dirty channel asks before leaving but not for its own jobs", async ({
      page,
    }) => {
      const state = await operationsFixture(page);
      await page.goto("/settings/updates");
      const check = page.getByRole("button", {
        name: t("Nach Updates suchen", "Check for updates"),
        exact: true,
      });
      await check.click();
      await page
        .getByRole("button", {
          name: t("Version vorbereiten", "Stage release"),
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/job=job-stage/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(preview(page)).toBeEnabled();
      // Release actions use the saved channel: an unsaved one blocks them.
      await preview(page).check();
      await expect(check).toBeDisabled();
      await expect(
        page.getByText(
          t("Speichere zuerst den Updatekanal.", "Save the update channel first."),
          { exact: true },
        ),
      ).toBeVisible();
      await page
        .getByRole("button", {
          name: t("Zurück zu Betrieb", "Back to Operations"),
          exact: true,
        })
        .click();
      const sheet = page.getByRole("dialog", {
        name: t("Änderungen speichern?", "Save changes?"),
      });
      await expect(sheet).toContainText(
        t(
          "Im Tab Updates ist 1 Änderung noch nicht gespeichert.",
          "1 change in Updates is not saved yet.",
        ),
      );
      await sheet
        .getByRole("button", {
          name: t("Speichern und wechseln", "Save and switch"),
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(/\/settings\?tab=operations$/);
      expect(
        state.calls.filter(
          (call) => call.method === "PUT" && call.path.endsWith("/releases/channel"),
        ),
      ).toHaveLength(1);
    });
  });
}
