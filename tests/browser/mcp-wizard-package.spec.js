import { test, expect } from "@playwright/test";
import {
  chooseSource,
  fits,
  openWizard,
  phone,
  wizardSetup,
  writes,
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

    test("install previews inline, saves once and shows the progress", async ({
      page,
    }) => {
      const state = await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Package from npm or PyPI");
      await wizard.getByLabel("Package", { exact: true }).fill("server-x");
      await expect(wizard.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
      await wizard.getByRole("button", { name: "Continue", exact: true }).click();
      await wizard.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(wizard.getByText("server-x · 0 settings (0 secret)")).toBeVisible();
      const confirmation = wizard.getByRole("region", { name: "Install this package?" });
      await expect(confirmation.getByText("server-x@1.1.0")).toBeVisible();
      await confirmation.getByRole("button", { name: "Install" }).click();
      await expect(wizard.getByText("Saved", { exact: true })).toBeVisible();
      const created = writes(state).filter((r) => r.path === "/api/mcp-servers");
      expect(created).toHaveLength(1);
      expect(created[0].body).toMatchObject({
        name: "server-x",
        transport: "stdio",
        source: { registry: "npm", name: "server-x", version: "1.1.0" },
        confirmInstall: true,
        previewId: "p1",
        origin: "manual",
      });
      expect(created[0].body.clis).toBeUndefined();
      await expect(wizard.getByText(/continues in the background/)).toBeVisible();
      state.finishInstall();
      await expect(wizard.getByText("Installed", { exact: true })).toBeVisible({
        timeout: 6000,
      });
      await wizard.getByRole("button", { name: "Next: connect" }).click();
      await expect(page).toHaveURL(/step=connect/);
    });

    test("a refused preview returns to the package with the message at the version", async ({
      page,
    }) => {
      const state = await wizardSetup(page);
      state.refusePreview = {
        status: 409,
        json: { error: "zurückgezogen", messageKey: "mcpPackages.versionYanked" },
      };
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Package from npm or PyPI");
      await wizard.getByLabel("Package", { exact: true }).fill("server-x");
      await expect(wizard.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
      await wizard.getByRole("button", { name: "Continue", exact: true }).click();
      await wizard.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page).toHaveURL(/step=package/);
      await expect(wizard.getByLabel("Version", { exact: true })).toHaveAttribute(
        "aria-invalid",
        "true",
      );
    });
  });
}
