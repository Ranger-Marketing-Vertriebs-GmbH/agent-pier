import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import {
  craftManifest,
  craftPlatform,
} from "../../server/features/tools/craft-manifest.js";
import { reaManifest, reaPlatform } from "../../server/features/tools/rea-manifest.js";
import { reaComponentStates } from "../../server/features/tools/rea-state.js";

// Fixture for the Craft Anything card and its dialog: a stubbed /api/craft-anything
// and the card on CLIs & extensions › Installation.

// Sizes and versions as the server reports them on an Apple silicon Mac (macOS 15),
// straight from the manifests, so the fixture cannot drift from the pins.
const host = craftPlatform({ platform: "darwin", arch: "arm64" });
const pinned = reaComponentStates({
  host: reaPlatform({ platform: "darwin", arch: "arm64", darwinMajor: 24 }),
  manifest: reaManifest,
  ghidra: null,
  jdk: null,
  frida: false,
});

export function craftState(overrides = {}) {
  const { components = {}, ...rest } = overrides;
  return {
    available: true,
    reason: null,
    status: "idle",
    jobCount: 0,
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
        pinnedVersion: craftManifest.version,
        downloadSize: host.entry.size,
        installedSize: host.entry.installedSize,
        outdated: false,
        ...components.core,
      },
      ghidra: { ...pinned.ghidra, outdated: false, shared: false, ...components.ghidra },
    },
    settings: { mode: "clean-room" },
    ...rest,
  };
}

/** An installed Craft Anything (version 0.5.0, Ghidra chosen), with `extra` on top. */
export const installedCraft = (extra = {}) =>
  craftState({
    installed: true,
    serverId: "srv-craft",
    serverName: "craft-anything",
    ...extra,
    components: {
      ...extra.components,
      core: {
        installed: true,
        version: craftManifest.version,
        ...extra.components?.core,
      },
      ghidra: {
        installed: true,
        wanted: true,
        version: reaManifest.ghidra.version,
        jdkVersion: reaManifest.jdk.version,
        ...extra.components?.ghidra,
      },
    },
  });

export async function fixture(
  page,
  craft = craftState(),
  { apply, uninstall, path: start = "/coding/clis" } = {},
) {
  const state = {
    tools: [{ id: "claude", name: "Claude Code", installed: true }],
    utilities: [
      {
        id: "craft-anything",
        name: "Craft Anything",
        utility: true,
        installed: craft.installed,
        version: craft.installed ? craft.components.core.version : null,
        pinnedVersion: craftManifest.version,
        updateAvailable: craft.updateAvailable,
        status: "idle",
      },
    ],
    accounts: [],
    sessions: [],
    home: "/home/server",
    remoteUrl: null,
  };
  const controls = { applied: [], updates: 0, removes: 0, generic: 0 };
  let jobCount = craft.jobCount ?? 0;
  await page.route("**/api/**", async (route) => {
    if (await fulfillDormantAssistantRequest(route)) return;
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path.startsWith("/api/tools/craft-anything")) {
      controls.generic++;
      return route.fulfill({ status: 404, json: {} });
    }
    // As the server: a started job answers running and raises jobCount.
    if (path === "/api/craft-anything" && method === "GET")
      return route.fulfill({ json: { ...craft, jobCount } });
    if (path === "/api/craft-anything" && method === "POST") {
      controls.applied.push(request.postDataJSON());
      if (apply) return route.fulfill(apply);
      jobCount += 1;
      return route.fulfill({
        status: 202,
        json: { ...craft, status: "running", jobCount },
      });
    }
    if (path === "/api/craft-anything/update") {
      controls.updates++;
      jobCount += 1;
      return route.fulfill({
        status: 202,
        json: { ...craft, status: "running", jobCount },
      });
    }
    if (path === "/api/craft-anything" && method === "DELETE") {
      controls.removes++;
      if (uninstall) return route.fulfill(uninstall);
      return route.fulfill({ json: craftState() });
    }
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(base + start);
  return controls;
}

export const card = (page) =>
  page.locator(".tool-card").filter({
    has: page.getByRole("heading", { name: "Craft Anything", exact: true }),
  });

export async function openDialog(page, button = "Install") {
  await card(page).getByRole("button", { name: button }).click();
  const dialog = page.getByRole("dialog", { name: "Craft Anything" });
  await expect(dialog).toBeVisible();
  return dialog;
}
