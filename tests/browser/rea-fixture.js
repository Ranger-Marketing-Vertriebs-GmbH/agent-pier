import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import { reaManifest, reaPlatform } from "../../server/features/tools/rea-manifest.js";
import { reaComponentStates } from "../../server/features/tools/rea-state.js";

// Fixture for the REA card and its dialog: a stubbed /api/rea and the card on
// CLIs & extensions › Installation.

// Sizes and versions as the server reports them on an Apple silicon Mac (macOS 15),
// straight from the manifest, so the fixture cannot drift from the pins.
const pinned = reaComponentStates({
  host: reaPlatform({ platform: "darwin", arch: "arm64", darwinMajor: 24 }),
  manifest: reaManifest,
  ghidra: null,
  jdk: null,
  frida: false,
});

export function reaState(overrides = {}) {
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

export async function fixture(
  page,
  rea = reaState(),
  { uninstall, apply, path: start = "/coding/clis" } = {},
) {
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
  let started = false;
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
    // A started job is read as running once, then as ended, as the server pushes
    // job.rea: the start, then its end.
    if (path === "/api/rea" && method === "GET") {
      if (!started) return route.fulfill({ json: rea });
      started = false;
      return route.fulfill({ json: { ...rea, status: "running" } });
    }
    if (path === "/api/rea" && method === "POST") {
      controls.applied.push(request.postDataJSON());
      if (apply) return route.fulfill(apply);
      started = true;
      return route.fulfill({ status: 202, json: { ...rea, status: "running" } });
    }
    if (path === "/api/rea/update") {
      controls.updates++;
      started = true;
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
  // The full grid lives on CLIs & extensions › Installation.
  await page.goto(base + start);
  return controls;
}

export const card = (page) =>
  page.locator(".tool-card").filter({
    has: page.getByRole("heading", { name: "REA", exact: true }),
  });

export async function openDialog(page, button = "Install") {
  await card(page).getByRole("button", { name: button }).click();
  const dialog = page.getByRole("dialog", { name: "REA" });
  await expect(dialog).toBeVisible();
  return dialog;
}
