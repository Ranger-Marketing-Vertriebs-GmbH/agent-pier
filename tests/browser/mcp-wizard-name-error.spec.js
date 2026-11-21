// The MCP wizard names a refused server name under its field instead of the browser's
// bubble (feature test W8 B10), on a desktop and on a phone.
import { test, expect } from "../helpers/browser-test.js";
import {
  chooseSource,
  fits,
  openWizard,
  phone,
  primary,
  wizardSetup,
  writes,
} from "./mcp-wizard-fixture.js";

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("an invalid name is explained in place and typing a valid one clears it", async ({
      page,
    }) => {
      const state = await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      const name = wizard.getByLabel("Name", { exact: true });
      await name.fill("1 bad name!");
      await wizard
        .getByLabel("Address", { exact: true })
        .fill("https://mcp.example.test/mcp");
      await primary(wizard).click();
      const error = wizard.getByRole("alert").filter({ hasText: /letters, digits/ });
      await expect(error).toHaveText(
        "Enter 1 to 30 letters, digits, hyphens or underscores, starting with a letter.",
      );
      await expect(name).toHaveAttribute("aria-invalid", "true");
      await expect(name).toBeFocused();
      expect(writes(state)).toEqual([]);
      await name.fill("docs");
      await expect(error).toHaveCount(0);
      await expect(name).not.toHaveAttribute("aria-invalid", "true");
      await fits(page);
    });
  });
}
