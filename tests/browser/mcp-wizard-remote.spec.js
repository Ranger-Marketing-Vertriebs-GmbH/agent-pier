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

    test("an address guesses SSE and warns about http and tokens in the query", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await expect(wizard.getByText("Step 2 of 3")).toBeAttached();
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard
        .getByLabel("Address", { exact: true })
        .fill("http://mcp.example.test/sse?token=abc");
      await wizard.getByLabel("Address", { exact: true }).blur();
      await expect(wizard.getByText("Connection: SSE")).toBeVisible();
      await expect(
        wizard.getByText("Guessed from the address; change it if needed."),
      ).toBeVisible();
      await expect(
        wizard.getByText("SSE is an older kind; Codex cannot use it."),
      ).toBeVisible();
      await expect(wizard.getByText(/This address is not encrypted/)).toBeVisible();
      await expect(
        wizard.getByText("Put the token in a header instead; addresses are shown."),
      ).toBeVisible();
      await wizard.getByRole("button", { name: "Change" }).click();
      await wizard.getByRole("radio", { name: "HTTP", exact: true }).check();
      await expect(wizard.getByText("Connection: HTTP")).toBeVisible();
      await fits(page);
    });

    test("API key sign-in asks for a masked token with the Bearer prefix on", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await wizard.getByRole("radio", { name: /API key or token/ }).check();
      await expect(wizard.getByLabel("Header name")).toHaveValue("Authorization");
      await expect(wizard.getByLabel("Token", { exact: true })).toHaveAttribute(
        "type",
        "password",
      );
      await expect(wizard.getByRole("checkbox", { name: /Bearer/ })).toBeChecked();
      await wizard.getByRole("radio", { name: /^OAuth/ }).check();
      await wizard.getByText("Advanced").click();
      await expect(wizard.getByLabel("OAuth scope (optional)")).toBeVisible();
    });
  });
}
