import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import { reaManifest } from "../../server/features/tools/rea-manifest.js";
import { packagedServer } from "./mcp-packages-fixture.js";
import { wizardSetup } from "./mcp-wizard-fixture.js";
import { card, fixture, openDialog, reaState } from "./rea-fixture.js";

// The REA card and its dialog: components with sizes, safety and sandbox notes, the
// acknowledgement before the first install, own tools, update and uninstall.
const screenshot = process.env.AGENTPIER_REA_SCREENSHOT;

test("the REA dialog lists components with sizes and totals, safety and sandbox notes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const controls = await fixture(page);
  await expect(card(page).getByRole("button")).toHaveCount(1);
  const dialog = await openDialog(page);
  await expect(dialog).toContainText("REA Core");
  await expect(dialog).toContainText("Ghidra with decompiler + Temurin JDK");
  await expect(dialog).toContainText("Frida");
  await expect(dialog).toContainText("12.1.4");
  await expect(dialog).toContainText("17.23.2");
  await expect(dialog).toContainText("DRM");
  await expect(dialog).toContainText("morluto/rea");
  await expect(dialog).toContainText("unsandboxed");
  await expect(dialog).toContainText(
    "registers it with the CLIs it is bound to (Claude Code by default)",
  );
  await expect(dialog).toContainText("including the host's default profile");
  await expect(dialog.getByRole("checkbox", { name: "REA Core" })).toBeDisabled();
  await expect(dialog.getByRole("checkbox", { name: "REA Core" })).toBeChecked();
  const total = dialog.locator(".rea-total");
  await expect(total).toContainText("GB");
  const before = await total.textContent();
  if (screenshot) await dialog.screenshot({ path: screenshot });
  await dialog
    .getByRole("checkbox", { name: "Ghidra with decompiler + Temurin JDK" })
    .uncheck();
  await expect(total).not.toHaveText(before);
  await expect(total).toContainText("MB");
  expect(controls.generic).toBe(0);
});

test("install needs the acknowledgement and sends the chosen components and own tools", async ({
  page,
}) => {
  const controls = await fixture(page);
  const dialog = await openDialog(page);
  const install = dialog.getByRole("button", { name: "Install", exact: true });
  await expect(install).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: "Ghidra with decompiler + Temurin JDK" })
    .uncheck();
  await dialog.getByLabel("IDA MCP bridge configuration").fill("/x/ida.json");
  await dialog.getByRole("radio", { name: "IDA" }).check();
  await dialog.getByRole("checkbox", { name: /I understand/ }).check();
  await expect(install).toBeEnabled();
  await install.click();
  await expect.poll(() => controls.applied.length).toBe(1);
  expect(controls.applied[0]).toEqual({
    components: { ghidra: false, frida: true },
    settings: { provider: "ida", idaConfig: "/x/ida.json", hopperPath: "", jebUrl: "" },
    confirmInstall: true,
  });
});

test("an unavailable Ghidra row is disabled and names the reason", async ({ page }) => {
  await fixture(
    page,
    reaState({
      components: {
        ghidra: {
          available: false,
          reason:
            "Ghidra für REA gibt es auf Intel-Macs noch nicht; REA Core und frida lassen sich installieren.",
          reasonKey: "rea.ghidraIntelMac",
          downloadSize: null,
          installedSize: null,
        },
      },
    }),
  );
  const dialog = await openDialog(page);
  const ghidra = dialog.getByRole("checkbox", {
    name: "Ghidra with decompiler + Temurin JDK",
  });
  await expect(ghidra).toBeDisabled();
  await expect(ghidra).not.toBeChecked();
  await expect(dialog).toContainText("Ghidra for REA is not available on Intel Macs yet");
});

test("an installed REA offers Update and Uninstall; a 409 in use is shown", async ({
  page,
}) => {
  const installed = reaState({
    installed: true,
    serverId: "srv-rea",
    serverName: "rea",
    updateAvailable: true,
    components: {
      core: { installed: true, version: "6.7.0", packageStatus: "ready", outdated: true },
      ghidra: { installed: true, version: "12.1.4", jdkVersion: "21.0.13+9" },
      frida: { installed: true, version: "17.23.2" },
    },
  });
  const controls = await fixture(page, installed, {
    uninstall: {
      status: 409,
      json: {
        error:
          "REA läuft gerade in einer Session oder bei einem Agenten. Beende sie, bevor du REAs Bestandteile entfernst, änderst oder aktualisierst.",
        messageKey: "rea.inUse",
      },
    },
  });
  await expect(card(page)).toContainText("6.7.0");
  await expect(card(page)).toContainText("Update available");
  const dialog = await openDialog(page, "Manage");
  await expect(dialog).toContainText(
    `An update is available: REA Core ${reaManifest.core.version}.`,
  );
  await expect(dialog.getByRole("checkbox", { name: /I understand/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(() => controls.updates).toBe(1);
  await dialog.getByRole("button", { name: "Uninstall REA" }).click();
  const confirm = page.getByRole("dialog", { name: "Uninstall REA?" });
  await confirm.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect.poll(() => controls.removes).toBe(1);
  await expect(confirm.getByRole("alert")).toContainText(
    "REA is running in a session or for an agent",
  );
});

test("the start page row shows REA's update and opens its dialog, never the installer", async ({
  page,
}) => {
  const installed = reaState({
    installed: true,
    updateAvailable: true,
    components: { core: { installed: true, version: "6.7.0", outdated: true } },
  });
  const controls = await fixture(page, installed, { path: "/" });
  const tools = page.getByRole("region", { name: /Your tools/ });
  const row = tools
    .locator(".start-tool")
    .filter({ has: page.getByText("REA", { exact: true }) });
  await expect(row).toContainText("Update available · 6.7.0");
  await expect(row.locator(".start-tool-more")).toHaveCount(0);
  await row.getByRole("button", { name: "Manage: REA", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "REA" })).toBeVisible();
  expect(controls.generic).toBe(0);
});

test("the update note names Ghidra and the JDK when only their pins moved", async ({
  page,
}) => {
  const installed = reaState({
    installed: true,
    serverId: "srv-rea",
    serverName: "rea",
    updateAvailable: true,
    components: {
      core: {
        installed: true,
        version: "6.8.0",
        packageStatus: "ready",
        outdated: false,
      },
      ghidra: {
        installed: true,
        version: "12.1.3",
        jdkVersion: "21.0.12+7",
        outdated: true,
      },
    },
  });
  await fixture(page, installed);
  const dialog = await openDialog(page, "Manage");
  const note = dialog.getByText(/^An update is available:/);
  await expect(note).toHaveText(
    `An update is available: Ghidra ${reaManifest.ghidra.version} with JDK ${reaManifest.jdk.version}.`,
  );
  await expect(note).not.toContainText("REA Core");
});

test("a refused install shows the server reason in the dialog", async ({ page }) => {
  // A short window: the dialog body scrolls, and the reason must come into view.
  await page.setViewportSize({ width: 1280, height: 600 });
  const controls = await fixture(page, reaState(), {
    apply: {
      status: 400,
      json: {
        error: "Der Analyseanbieter IDA braucht den Pfad zu einer IDA-MCP-Konfiguration.",
        messageKey: "rea.idaConfigRequired",
      },
    },
  });
  const dialog = await openDialog(page);
  await dialog.getByRole("radio", { name: "IDA" }).check();
  await dialog.getByRole("checkbox", { name: /I understand/ }).check();
  // The owner scrolled back up to the components before installing.
  await dialog.evaluate((element) => (element.scrollTop = 0));
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  await expect.poll(() => controls.applied.length).toBe(1);
  const alert = dialog.getByRole("alert");
  await expect(alert).toHaveText(
    "The IDA analysis provider needs the path to an IDA MCP configuration.",
  );
  await expect(alert).toBeInViewport();
});

test("a managed REA row has no Remove, links to the REA card and locks managed env names", async ({
  page,
}) => {
  const managed = packagedServer("ready", {
    id: "s1",
    name: "rea-agentpier",
    envNames: ["JAVA_HOME", "MY_KEY"],
    managed: { tool: "rea", lockedEnv: ["JAVA_HOME"] },
  });
  await wizardSetup(page, { servers: [managed] });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(`${base}/accounts?section=mcp-servers&item=s1`);
  const view = page.locator(".accounts-detail");
  await expect(
    view.getByRole("heading", { name: "rea-agentpier" }).first(),
  ).toBeVisible();
  await expect(view.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await expect(view.getByText(/AgentPier manages this server/)).toBeVisible();
  const link = view.getByRole("link", { name: "Manage REA" });
  await expect(link).toHaveAttribute("href", /\/coding\/clis$/);
  await expect(
    view.getByRole("region", { name: "Source and name" }).getByRole("button"),
  ).toHaveCount(0);
  // The package is REA's: no update check, no reinstall.
  await expect(view.getByRole("button", { name: "Check update" })).toHaveCount(0);
  await expect(view.getByRole("button", { name: "Reinstall" })).toHaveCount(0);
  await view.getByRole("button", { name: "Change: Settings" }).click();
  const rows = page.locator(".accounts-detail .mcp-row");
  const locked = rows.filter({ hasText: "JAVA_HOME" });
  await expect(locked).toContainText("managed by AgentPier");
  await expect(locked.locator("input")).toHaveCount(0);
  await expect(locked.getByRole("button")).toHaveCount(0);
  const own = rows.filter({ hasText: "MY_KEY" });
  await expect(own.getByLabel("MY_KEY: New value (leave empty to keep)")).toBeEditable();
  await expect(own.getByRole("button", { name: "Remove" })).toBeVisible();
});
