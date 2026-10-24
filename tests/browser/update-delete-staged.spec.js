import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`staged release deletion ${locale}`, () => {
    test.use({ locale });
    test("a staged release is deleted after a destructive confirmation", async ({
      page,
    }, testInfo) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      state.releases.staged = [
        { id: "staged-one", version: "1.1.0-rc.2" },
        { id: "staged-two", version: "1.2.0" },
      ];
      let versions = [
        { version: "1.2.0", canDelete: false, deleteReason: "inUse", newer: true },
        { version: "1.1.0-rc.2", canDelete: true, deleteReason: null, newer: true },
        { version: "1.0.0", canDelete: false, deleteReason: "active", newer: false },
        { version: "0.9.0", canDelete: true, deleteReason: null, newer: false },
      ].map((item) => ({
        ...item,
        stagedIds: state.releases.staged
          .filter((staged) => staged.version === item.version)
          .map((staged) => staged.id),
        orphanedProcesses: [],
      }));
      const calls = [];
      await page.route("**/api/operations/releases/cleanup", async (route) => {
        if (route.request().method() === "GET")
          return route.fulfill({ json: { available: true, versions } });
        const body = route.request().postDataJSON();
        calls.push(body);
        versions = versions.filter((item) => !body.versions.includes(item.version));
        state.releases.staged = state.releases.staged.filter(
          (item) => !body.versions.includes(item.version),
        );
        const id = `cleanup-${calls.length}`;
        state.jobs[id] = {
          id,
          kind: "release-cleanup",
          result: { removedVersions: body.versions },
        };
        return route.fulfill({ status: 202, json: { job: { id } } });
      });
      await page.goto("/settings/updates");
      const label = en ? "Delete" : "Löschen";
      const remove = page.getByRole("button", {
        name: `${label}: 1.1.0-rc.2`,
        exact: true,
      });
      // A staged version that a running process uses keeps its package.
      await expect(
        page.getByRole("button", { name: `${label}: 1.2.0`, exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByText(
          en ? "Used by a running process" : "Von laufendem Prozess verwendet",
        ),
      ).toHaveCount(1);
      await expect(remove).toBeEnabled();
      // Staged packages are not offered among the old versions.
      await page
        .getByText(en ? "Delete old versions" : "Alte Versionen löschen", { exact: true })
        .click();
      const old = en ? "Delete version" : "Version löschen";
      await expect(
        page.getByRole("button", { name: new RegExp(`^${old}: `) }),
      ).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: `${old}: 0.9.0`, exact: true }),
      ).toBeVisible();
      if (en)
        await remove
          .locator("xpath=ancestor::article")
          .screenshot({ path: testInfo.outputPath("release-delete-card.png") });
      await remove.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(
        en ? "Delete 1.1.0-rc.2?" : "1.1.0-rc.2 löschen?",
      );
      await expect(dialog).toContainText(
        en
          ? "The package is removed and this version can no longer be activated."
          : "Das Paket wird entfernt, und diese Version lässt sich danach nicht mehr aktivieren.",
      );
      const cancel = dialog.getByRole("button", {
        name: en ? "Cancel" : "Abbrechen",
        exact: true,
      });
      await expect(cancel).toBeFocused();
      if (en)
        await page.screenshot({
          path: testInfo.outputPath("release-delete-confirm.png"),
        });
      await cancel.click();
      expect(calls).toHaveLength(0);
      await remove.click();
      await dialog
        .getByRole("button", { name: en ? "Delete now" : "Jetzt löschen", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      expect(calls).toEqual([{ versions: ["1.1.0-rc.2"] }]);
      await expect(remove).toHaveCount(0);
      await expect(page.getByRole("heading", { name: /1\.1\.0-rc\.2/ })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: /1\.2\.0/ })).toHaveCount(1);
    });
  });
}
