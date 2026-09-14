import { test, expect } from "@playwright/test";
import { fixture } from "../helpers/repository-browser.js";

for (const locale of ["de-DE", "en-GB"]) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 390, height: 844 } });
    test("token commit identity can be added, edited and cleared without resending the token", async ({
      page,
    }) => {
      const { writes } = await fixture(page);
      const en = locale === "en-GB";
      await page.goto("/repositories");
      await page
        .getByRole("button", { name: en ? "Add token" : "Token hinzufügen", exact: true })
        .click();
      await page
        .getByLabel(en ? "Profile name" : "Profilname", { exact: true })
        .fill("Work");
      await page
        .getByLabel(en ? "Access token" : "Access Token", { exact: true })
        .fill("fixture-token");
      const name = page.getByLabel(
        en ? "Commit name (optional)" : "Commit-Name (optional)",
        { exact: true },
      );
      const email = page.getByLabel(
        en ? "Commit email (optional)" : "Commit-E-Mail (optional)",
        { exact: true },
      );
      await name.fill("Work Author");
      await email.fill("work@example.test");
      const save = () =>
        page
          .getByRole("button", {
            name: en ? "Save token" : "Token speichern",
            exact: true,
          })
          .click();
      await save();
      await expect(
        page.getByText("Work Author <work@example.test>", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: en ? "Edit Work" : "Work bearbeiten", exact: true })
        .click();
      await expect(name).toHaveValue("Work Author");
      await expect(email).toHaveValue("work@example.test");
      await expect(
        page.getByLabel(en ? "Access token" : "Access Token", { exact: true }),
      ).toHaveValue("");
      await name.fill("Updated Author");
      await page.screenshot({ path: test.info().outputPath("commit-identity.png") });
      await save();
      expect(writes.at(-1).body.commitIdentity).toEqual({
        name: "Updated Author",
        email: "work@example.test",
      });
      expect(writes.at(-1).body.token).toBeUndefined();
      await page
        .getByRole("button", { name: en ? "Edit Work" : "Work bearbeiten", exact: true })
        .click();
      await name.fill("");
      await email.fill("");
      await save();
      expect(writes.at(-1).body.commitIdentity).toBeNull();
      await expect(
        page.getByText("Updated Author <work@example.test>", { exact: true }),
      ).toHaveCount(0);
    });
  });
}
