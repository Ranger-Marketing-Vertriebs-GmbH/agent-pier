import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import {
  chooseSource,
  fits,
  openWizard,
  phone,
  primary,
  wizardSetup,
} from "./mcp-wizard-fixture.js";

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("a reload on a deep step starts over with a notice", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page, "&step=settings");
      await expect(page).not.toHaveURL(/step=/);
      await expect(wizard.getByRole("status")).toHaveText(
        "The setup was not saved. Start again.",
      );
    });

    test("browser back and forward move between visited steps only", async ({ page }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard
        .getByLabel("Address", { exact: true })
        .fill("https://mcp.example.test/mcp");
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=settings/);
      await page.goBack();
      await expect(page).toHaveURL(/step=remote/);
      await expect(wizard.getByLabel("Address", { exact: true })).toHaveValue(
        "https://mcp.example.test/mcp",
      );
      await page.goBack();
      await expect(
        wizard.getByRole("radio", { name: "Server on the internet" }),
      ).toBeChecked();
      await page.goForward();
      await expect(page).toHaveURL(/step=remote/);
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=new&step=connect`);
      await expect(page).not.toHaveURL(/step=connect/);
    });

    test("the step heading takes focus and the indicator marks the step", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Package from npm or PyPI");
      await expect(wizard.getByRole("heading", { level: 1 })).toBeFocused();
      await expect(wizard.locator('li[aria-current="step"]')).toHaveText("Set up");
      await expect(wizard.getByText("Step 2 of 4")).toBeAttached();
      await fits(page);
    });

    test("closing with typed input asks before discarding", async ({ page }) => {
      const state = await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard.getByRole("button", { name: "Close" }).click();
      const sheet = page.getByRole("dialog", { name: "Discard this new server?" });
      await sheet.getByRole("button", { name: "Keep editing" }).click();
      await expect(wizard.getByLabel("Name", { exact: true })).toHaveValue("docs");
      await wizard.getByRole("button", { name: "Close" }).click();
      await sheet.getByRole("button", { name: "Discard" }).click();
      await expect(page).toHaveURL(/section=mcp-servers$/);
      expect(state.requests.filter((r) => r.method !== "GET")).toEqual([]);
    });

    test("Enter in a field submits the step's primary action", async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, "Keyboard submit is a desktop behaviour.");
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard
        .getByLabel("Address", { exact: true })
        .fill("https://mcp.example.test/mcp");
      await wizard.getByLabel("Address", { exact: true }).press("Enter");
      await expect(page).toHaveURL(/step=settings/);
    });

    test("German copy on the Source step", async ({ page }) => {
      await wizardSetup(page, { language: "de" });
      const wizard = await openWizard(page);
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Woher kommt der Server?" }),
      ).toBeVisible();
      await expect(
        wizard.getByRole("radio", { name: "Paket aus npm oder PyPI" }),
      ).toBeVisible();
    });
  });
}
