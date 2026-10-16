import { test, expect } from "@playwright/test";
import {
  agent,
  chooseSource,
  commandToConnect,
  openWizard,
  phone,
  primary,
  withAgents,
  wizardSetup,
} from "./mcp-wizard-fixture.js";

const home = () => agent("home", "Home");
const shared = () => agent("haus", "Haus", { telegramSenders: true });
const later = (state) =>
  state.requests.filter((r) => r.method === "PUT" || r.method === "PATCH");

for (const [label, use] of [
  ["desktop", {}],
  ["phone", phone],
]) {
  test.describe(label, () => {
    test.use(use);

    test("one consent card covers the chosen CLIs and agents of a local command", async ({
      page,
    }) => {
      const state = await wizardSetup(page, { agents: true });
      await withAgents(page, state, [home(), shared()]);
      const wizard = await openWizard(page);
      await commandToConnect(wizard);
      const consent = wizard.getByRole("region", { name: "What this allows" });
      await expect(
        consent.getByText(/Runs on this computer with your user's rights/),
      ).toBeVisible();
      await expect(consent.getByText(/No known write switch/)).toBeVisible();
      await expect(wizard.getByRole("switch", { name: "Haus" })).toBeDisabled();
      await expect(wizard.getByText(/own Telegram bot for other people/)).toBeVisible();
      await wizard.getByRole("switch", { name: "Claude Code" }).check();
      await wizard.getByRole("switch", { name: "Home" }).check();
      await expect(consent.getByText("Home: shell Off")).toBeVisible();
      await expect(primary(wizard)).toHaveText("Allow and connect");
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=done/);
      expect(later(state)).toEqual([
        {
          method: "PUT",
          path: "/api/mcp-servers/s1",
          body: { revision: 1, clis: ["claude"], confirmStdio: true },
        },
        {
          method: "PATCH",
          path: "/api/assistants/home",
          body: { mcpServers: ["s1"], revision: 1, confirmStdio: true },
        },
      ]);
    });

    test("the consent names the write switch the settings set", async ({ page }) => {
      const state = await wizardSetup(page, { agents: true });
      await withAgents(page, state, [home()]);
      const wizard = await openWizard(page);
      await commandToConnect(wizard, [["OPNSENSE_ALLOW_WRITES", "false"]]);
      await expect(
        wizard.getByText("OPNSENSE_ALLOW_WRITES is off, so it can only read."),
      ).toBeVisible();
    });

    test("a remote server needs no local-command consent and may go to Telegram agents", async ({
      page,
    }) => {
      const state = await wizardSetup(page, { agents: true });
      await withAgents(page, state, [shared()]);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Server on the internet");
      await wizard.getByLabel("Name", { exact: true }).fill("docs");
      await wizard
        .getByLabel("Address", { exact: true })
        .fill("https://mcp.example.test/mcp");
      await primary(wizard).click();
      await primary(wizard).click();
      await wizard.getByRole("button", { name: "Save server" }).click();
      await expect(wizard.getByText(/Runs on this computer/)).toHaveCount(0);
      await wizard.getByRole("switch", { name: "Haus" }).check();
      await expect(primary(wizard)).toHaveText("Save and connect");
      await primary(wizard).click();
      await expect(page).toHaveURL(/step=done/);
      expect(later(state)[0].body).toEqual({ mcpServers: ["s1"], revision: 1 });
    });

    test("Skip for now binds nothing", async ({ page }) => {
      const state = await wizardSetup(page);
      const wizard = await openWizard(page);
      await commandToConnect(wizard);
      await wizard.getByRole("button", { name: "Skip for now" }).click();
      await expect(page).toHaveURL(/step=done/);
      expect(later(state)).toEqual([]);
    });

    test("while the package installs, the choice waits and closing warns", async ({
      page,
    }) => {
      const state = await wizardSetup(page, { agents: true });
      await withAgents(page, state, [home()]);
      const wizard = await openWizard(page);
      await chooseSource(wizard, "Package from npm or PyPI");
      await wizard.getByLabel("Package", { exact: true }).fill("server-x");
      await expect(wizard.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
      await primary(wizard).click();
      await primary(wizard).click();
      await wizard
        .getByRole("region", { name: "Install this package?" })
        .getByRole("button", { name: "Install" })
        .click();
      await wizard.getByRole("button", { name: "Continue", exact: true }).click();
      await wizard.getByRole("switch", { name: "Claude Code" }).check();
      await wizard.getByRole("switch", { name: "Home" }).check();
      await expect(primary(wizard)).toHaveText("Connect when installed");
      await primary(wizard).click();
      await expect(
        wizard.getByText(/Connecting as soon as the package is installed/),
      ).toBeVisible();
      await wizard.getByRole("button", { name: "Close" }).click();
      const sheet = page.getByRole("dialog", { name: "Leave before connecting?" });
      await expect(
        sheet.getByText("Your CLI and agent choice is not saved yet."),
      ).toBeVisible();
      await sheet.getByRole("button", { name: "Keep editing" }).click();
      expect(later(state)).toEqual([]);
      state.finishInstall();
      await expect(page).toHaveURL(/step=done/, { timeout: 8000 });
      expect(later(state).map((r) => r.method)).toEqual(["PUT", "PATCH"]);
    });
  });
}
