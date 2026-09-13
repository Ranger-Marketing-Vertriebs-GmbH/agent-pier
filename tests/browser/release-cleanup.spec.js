import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";
for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`release cleanup ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 } });
    test("individual and bulk cleanup confirm the exact selection and preserve protected versions", async ({
      page,
    }, testInfo) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      let versions = [
        { version: "0.7.0", canDelete: true },
        { version: "0.8.0", canDelete: true },
        { version: "0.9.0", canDelete: false, deleteReason: "inUse" },
        { version: "1.0.0", canDelete: false, deleteReason: "active" },
      ];
      const calls = [];
      await page.route("**/api/operations/releases/cleanup", async (route) => {
        if (route.request().method() === "GET")
          return route.fulfill({ json: { available: true, versions } });
        const body = route.request().postDataJSON();
        calls.push(body);
        versions = versions.filter((item) => !body.versions.includes(item.version));
        const id = `cleanup-${calls.length}`;
        state.jobs[id] = {
          id,
          kind: "release-cleanup",
          result: { removedVersions: body.versions },
        };
        return route.fulfill({ status: 202, json: { job: { id } } });
      });
      await page.goto("/settings/updates");
      await page
        .getByText(en ? "Remove old versions" : "Alte Versionen aufräumen", {
          exact: true,
        })
        .click();
      const label = en ? "Delete version" : "Version löschen";
      await expect(
        page.getByRole("button", { name: `${label}: 0.9.0`, exact: true }),
      ).toBeDisabled();
      await page.getByRole("button", { name: `${label}: 0.7.0`, exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("0.7.0");
      await page
        .getByRole("button", { name: en ? "Cancel" : "Abbrechen", exact: true })
        .click();
      expect(calls).toHaveLength(0);
      await page.getByRole("button", { name: `${label}: 0.7.0`, exact: true }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: en ? "Confirm" : "Bestätigen", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: `${label}: 0.7.0`, exact: true }),
      ).toHaveCount(0);
      expect(calls[0]).toEqual({ versions: ["0.7.0"] });
      await page.screenshot({
        path: testInfo.outputPath("release-cleanup-mobile.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", {
          name: en ? "Delete all old versions" : "Alle alten Versionen löschen",
          exact: true,
        })
        .click();
      await expect(page.getByRole("dialog")).toContainText("0.8.0");
      await expect(page.getByRole("dialog")).not.toContainText("0.9.0");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: en ? "Confirm" : "Bestätigen", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: `${label}: 0.8.0`, exact: true }),
      ).toHaveCount(0);
      expect(calls[1]).toEqual({ versions: ["0.8.0"] });
      await page.reload();
      expect(calls).toHaveLength(2);
    });
  });
}
