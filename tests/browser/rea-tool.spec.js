import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { reaManifest, reaPlatform } from "../../server/features/tools/rea-manifest.js";
import { reaComponentStates } from "../../server/features/tools/rea-state.js";

// The REA card and its dialog: components with sizes, safety and sandbox notes, the
// acknowledgement before the first install, own tools, update and uninstall.
const screenshot = process.env.AGENTPIER_REA_SCREENSHOT;

// Sizes and versions as the server reports them on an Apple silicon Mac (macOS 15),
// straight from the manifest, so the fixture cannot drift from the pins.
const pinned = reaComponentStates({
  host: reaPlatform({ platform: "darwin", arch: "arm64", darwinMajor: 24 }),
  manifest: reaManifest,
  ghidra: null,
  jdk: null,
  frida: false,
});

function reaState(overrides = {}) {
  const { components = {}, ...rest } = overrides;
  return {
    available: true,
    reason: null,
    status: "idle",
    step: null,
    message: "",
    installed: false,
    serverId: null,
    serverName: null,
    updateAvailable: false,
    components: {
      core: {
        installed: false,
        version: null,
        pinnedVersion: reaManifest.core.version,
        packageStatus: null,
        downloadSize: reaManifest.core.downloadSize,
        installedSize: reaManifest.core.installedSize,
        ...components.core,
      },
      ghidra: { ...pinned.ghidra, ...components.ghidra },
      frida: { ...pinned.frida, ...components.frida },
    },
    settings: { provider: "ghidra", hopperPath: null, idaConfig: null, jebUrl: null },
    ...rest,
  };
}

async function fixture(page, rea = reaState(), { uninstall, apply } = {}) {
  const state = {
    tools: [{ id: "claude", name: "Claude Code", installed: true }],
    utilities: [
      {
        id: "rea",
        name: "REA",
        utility: true,
        installed: rea.installed,
        version: rea.installed ? rea.components.core.version : null,
        pinnedVersion: "6.8.0",
        updateAvailable: rea.updateAvailable,
        status: "idle",
      },
    ],
    accounts: [],
    sessions: [],
    home: "/home/server",
    remoteUrl: null,
  };
  const controls = { applied: [], updates: 0, removes: 0, generic: 0 };
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path.startsWith("/api/tools/rea")) {
      controls.generic++;
      return route.fulfill({ status: 404, json: {} });
    }
    if (path === "/api/rea" && method === "GET") return route.fulfill({ json: rea });
    if (path === "/api/rea" && method === "POST") {
      controls.applied.push(request.postDataJSON());
      if (apply) return route.fulfill(apply);
      return route.fulfill({ status: 202, json: { ...rea, status: "running" } });
    }
    if (path === "/api/rea/update") {
      controls.updates++;
      return route.fulfill({ status: 202, json: { ...rea, status: "running" } });
    }
    if (path === "/api/rea" && method === "DELETE") {
      controls.removes++;
      if (uninstall) return route.fulfill(uninstall);
      return route.fulfill({ json: reaState() });
    }
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(base);
  return controls;
}

const card = (page) =>
  page.locator(".tool-card").filter({
    has: page.getByRole("heading", { name: "REA", exact: true }),
  });

async function openDialog(page, button = "Install") {
  await card(page).getByRole("button", { name: button }).click();
  const dialog = page.getByRole("dialog", { name: "REA" });
  await expect(dialog).toBeVisible();
  return dialog;
}

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
      core: { installed: true, version: "6.7.0", packageStatus: "ready" },
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
