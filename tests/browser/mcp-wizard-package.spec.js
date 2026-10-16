import { test, expect } from "@playwright/test";
import {
  chooseSource,
  fits,
  openWizard,
  phone,
  wizardSetup,
} from "./mcp-wizard-fixture.js";

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("the package step looks the package up and names who published it", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await expect(wizard.getByText("Step 1 of 3")).toBeAttached();
      await chooseSource(wizard, "Package from npm or PyPI");
      await expect(wizard.getByText("Step 2 of 4")).toBeAttached();
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Which package?" }),
      ).toBeFocused();
      await wizard.getByLabel("Package", { exact: true }).fill("@jdoe/server-x");
      await expect(
        wizard.getByText(/^Found: @jdoe\/server-x · newest 1\.1\.0/),
      ).toBeVisible();
      await expect(
        wizard.getByText("Published by Jane Doe, jdoe (according to npm)"),
      ).toBeVisible();
      const link = wizard.getByRole("link", { name: "Source: github.com/jdoe/server-x" });
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      await expect(
        wizard.getByText("Link given by the publisher, not verified."),
      ).toBeVisible();
      await expect(
        wizard.getByText("Check who published the package before you install it."),
      ).toBeVisible();
      await expect(wizard.getByLabel("Name", { exact: true })).toHaveValue("server-x");
      await expect(wizard.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
      await expect(
        wizard.getByText("Allow install scripts or source builds"),
      ).toBeHidden();
      await wizard.getByText("More options").click();
      await expect(
        wizard.getByText("Allow install scripts or source builds"),
      ).toBeVisible();
      await fits(page);
      await wizard.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page).toHaveURL(/step=settings/);
    });

    test("a deprecated version warns at the version", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Package from npm or PyPI");
      await wizard.getByLabel("Package", { exact: true }).fill("server-x");
      await wizard.getByLabel("Version", { exact: true }).selectOption("1.0.0");
      await expect(
        wizard.getByText("The maintainers marked this version as deprecated."),
      ).toBeVisible();
    });
  });
}
