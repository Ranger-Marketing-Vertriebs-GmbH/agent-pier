import { test, expect } from "@playwright/test";
import {
  chooseSource,
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

    test("a command is looked up on this computer before continuing", async ({
      page,
    }) => {
      const state = await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, /Own command/);
      await wizard.getByLabel("Name", { exact: true }).fill("tool");
      await wizard.getByLabel("Command").fill("nope");
      await expect(wizard.getByText("Not found on this computer.")).toBeVisible();
      await expect(primary(wizard)).toBeDisabled();
      await wizard.getByLabel("Command").fill("uvx");
      await expect(wizard.getByText("Found: /opt/homebrew/bin/uvx")).toBeVisible();
      await expect(primary(wizard)).toBeEnabled();
      expect(
        state.requests.filter((r) => r.path === "/api/mcp-commands/resolve").at(-1).name,
      ).toBe("uvx");
    });
  });
}
