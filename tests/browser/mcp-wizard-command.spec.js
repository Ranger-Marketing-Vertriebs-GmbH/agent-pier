import { test, expect } from "@playwright/test";
import {
  chooseSource,
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

    test("settings mask secrets, refuse references and explain a write switch", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, /Own command/);
      await wizard.getByLabel("Name", { exact: true }).fill("tool");
      await wizard.getByLabel("Command").fill("uvx");
      await expect(wizard.getByText("Found: /opt/homebrew/bin/uvx")).toBeVisible();
      await primary(wizard).click();
      await expect(
        wizard.getByRole("heading", { level: 1, name: "Settings for tool" }),
      ).toBeFocused();
      await wizard.getByRole("button", { name: "Add a setting" }).click();
      const first = wizard.locator(".mcp-setting").nth(0);
      await first.getByLabel("Name", { exact: true }).fill("API_TOKEN");
      const value = first.getByLabel("Value", { exact: true });
      await value.fill("${GITHUB_TOKEN}");
      await expect(value).toHaveAttribute("type", "password");
      await expect(first.getByRole("alert")).toHaveText(
        "This value points to another setting (${…}). Type the real value here.",
      );
      await expect(value).toHaveAttribute("aria-invalid", "true");
      await first.getByRole("button", { name: "Show the value of API_TOKEN" }).click();
      await expect(value).toHaveAttribute("type", "text");
      await value.fill("abc");
      await expect(first.getByRole("alert")).toHaveCount(0);
      await wizard.getByRole("button", { name: "Add a setting" }).click();
      const second = wizard.locator(".mcp-setting").nth(1);
      await second.getByLabel("Name", { exact: true }).fill("OPNSENSE_ALLOW_WRITES");
      await expect(
        second.getByText(/decides whether the server may change things/),
      ).toBeVisible();
      await wizard.getByText(/^Arguments and working directory/).click();
      await wizard.getByRole("button", { name: "Add an argument" }).click();
      await wizard.getByLabel("Argument 1", { exact: true }).fill("--read-only");
      await wizard
        .getByLabel("Working directory (optional, absolute path)")
        .fill("/tmp/work");
      await expect(
        wizard.getByText("Claude Code cannot use a server with a working directory."),
      ).toBeVisible();
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=review/);
    });

    test("a setting name the server refuses is named before continuing", async ({
      page,
    }) => {
      await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, /Own command/);
      await wizard.getByLabel("Name", { exact: true }).fill("tool");
      await wizard.getByLabel("Command").fill("uvx");
      await expect(primary(wizard)).toBeEnabled();
      await primary(wizard).click();
      await wizard.getByRole("button", { name: "Add a setting" }).click();
      const row = wizard.locator(".mcp-setting");
      await row.getByLabel("Name", { exact: true }).fill("1-BAD");
      await row.getByLabel("Value", { exact: true }).fill("x");
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=settings/);
      await expect(
        wizard.getByText(
          "Letters, digits and underscores; it cannot start with a digit.",
        ),
      ).toBeVisible();
    });

    test("an own command is allowed and saved with its settings and arguments", async ({
      page,
    }) => {
      const state = await wizardSetup(page);
      const wizard = await openWizard(page);
      await chooseSource(wizard, /Own command/);
      await wizard.getByLabel("Name", { exact: true }).fill("tool");
      await wizard.getByLabel("Command").fill("uvx");
      await expect(primary(wizard)).toBeEnabled();
      await primary(wizard).click();
      await wizard.getByRole("button", { name: "Add a setting" }).click();
      await wizard
        .locator(".mcp-setting")
        .getByLabel("Name", { exact: true })
        .fill("API_TOKEN");
      await wizard
        .locator(".mcp-setting")
        .getByLabel("Value", { exact: true })
        .fill("abc");
      await wizard.getByText(/^Arguments and working directory/).click();
      await wizard.getByRole("button", { name: "Add an argument" }).click();
      await wizard.getByLabel("Argument 1", { exact: true }).fill("--read-only");
      await primary(wizard).click();
      await expect(wizard.getByText("Run a local command?")).toBeVisible();
      await wizard.getByRole("button", { name: "Allow and save" }).click();
      await expect(page).toHaveURL(/step=connect/);
      expect(writes(state)[0].body).toEqual({
        name: "tool",
        transport: "stdio",
        command: "uvx",
        args: ["--read-only"],
        env: { API_TOKEN: "abc" },
        confirmStdio: true,
        origin: "manual",
      });
    });
  });
}
