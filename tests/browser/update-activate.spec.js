import { test, expect } from "@playwright/test";
import { operationsFixture } from "./operations-fixture.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(`update activation ${locale}`, () => {
    test.use({ locale, viewport: { width: 390, height: 844 } });
    test("activation offers to migrate sessions and rollback does not", async ({
      page,
    }) => {
      const en = locale === "en-GB";
      const state = await operationsFixture(page);
      state.releases.staged = [{ id: "staged-one", version: "1.1.0" }];
      await page.goto("/settings/updates");
      const activate = page.getByRole("button", {
        name: `${en ? "Activate staged release" : "Vorbereitete Version aktivieren"}: 1.1.0`,
        exact: true,
      });
      await activate.click();
      const checkbox = page.getByRole("checkbox", {
        name: en
          ? "Move running sessions to the new version afterwards"
          : "Laufende Sessions danach auf die neue Version umziehen",
      });
      await expect(checkbox).not.toBeChecked();
      await expect(checkbox).toHaveAttribute("aria-describedby", "activate-reload-help");
      await expect(page.locator("#activate-reload-help")).toContainText(
        en ? "health check" : "Zustandsprüfung",
      );
      await expect(page.getByRole("dialog")).toContainText(
        en ? "health check" : "Zustandsprüfung",
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: en ? "Confirm" : "Bestätigen", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const first = state.calls.find(
        (call) => call.path === "/operations/releases/activate" && call.method === "POST",
      );
      expect(first.body).toEqual({ stagedId: "staged-one" });
      await page.goto("/settings/updates");
      await activate.click();
      await checkbox.check();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: en ? "Confirm" : "Bestätigen", exact: true })
        .click();
      const posts = state.calls.filter(
        (call) => call.path === "/operations/releases/activate" && call.method === "POST",
      );
      expect(posts.at(-1).body).toEqual({ stagedId: "staged-one", reloadSessions: true });
      await page.goto("/settings/updates");
      await page
        .getByText(
          en ? "Previous versions and rollback" : "Frühere Versionen und Rollback",
          { exact: true },
        )
        .click();
      await page
        .getByRole("button", {
          name: en ? "Roll back version" : "Version zurücksetzen",
          exact: true,
        })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("checkbox")).toHaveCount(0);
    });
  });
}
