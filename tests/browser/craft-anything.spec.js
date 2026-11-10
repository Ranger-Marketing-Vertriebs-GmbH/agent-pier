import { test, expect } from "../helpers/browser-test.js";
import { baseURL as base } from "../helpers/browser.js";
import {
  craftManifest,
  craftPlatform,
} from "../../server/features/tools/craft-manifest.js";
import { formatBytes } from "../../web/lib/format-bytes.js";
import { reaManifest } from "../../server/features/tools/rea-manifest.js";
import { wizardSetup } from "./mcp-wizard-fixture.js";
import {
  card,
  craftState,
  fixture,
  installedCraft,
  openDialog,
} from "./craft-anything-fixture.js";

// The Craft Anything card and its dialog: components with sizes, the responsible-use
// note before the first install, the deep mode switch, update and removal, and its
// managed MCP row.
const screenshot = process.env.AGENTPIER_CRAFT_SCREENSHOT;
const ghidraRow = "Ghidra with decompiler + Temurin JDK";
// The total of Craft Anything alone, as the fixture's Apple silicon Mac reports it.
const { entry } = craftPlatform({ platform: "darwin", arch: "arm64" });
const craftOnly = `Total: download ${formatBytes(entry.size, "en")}, installed ${formatBytes(entry.installedSize, "en")}`;

test("installs after acknowledging the note", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const controls = await fixture(page);
  await expect(card(page).getByRole("button")).toHaveCount(1);
  const dialog = await openDialog(page);
  await expect(dialog).toContainText("Craft Anything");
  await expect(dialog).toContainText(craftManifest.version);
  await expect(dialog).toContainText("DRM");
  await expect(dialog).toContainText("anti-cheat");
  await expect(dialog).toContainText("early alpha");
  await expect(dialog).toContainText("clean room");
  const core = dialog.getByRole("checkbox", { name: "Craft Anything", exact: true });
  await expect(core).toBeChecked();
  await expect(core).toBeDisabled();
  // Clean room never needs Ghidra: a first install without it present leaves it off.
  const ghidra = dialog.getByRole("checkbox", { name: ghidraRow });
  await expect(ghidra).not.toBeChecked();
  const total = dialog.locator(".rea-total");
  await expect(total).toHaveText(craftOnly);
  const deep = dialog.getByRole("switch", { name: "Deep mode for sessions" });
  await expect(deep).not.toBeChecked();
  const install = dialog.getByRole("button", { name: "Install", exact: true });
  await expect(install).toBeDisabled();
  if (screenshot) await dialog.screenshot({ path: screenshot });
  await ghidra.check();
  await expect(total).toContainText("GB");
  await ghidra.uncheck();
  await expect(total).toHaveText(craftOnly);
  await dialog.getByRole("checkbox", { name: /I understand/ }).check();
  await install.click();
  await expect.poll(() => controls.applied.length).toBe(1);
  expect(controls.applied[0]).toEqual({
    components: { ghidra: false },
    settings: { mode: "clean-room" },
    confirmInstall: true,
  });
  await expect(dialog.getByRole("status")).toContainText(
    "Craft Anything is being changed",
  );
  expect(controls.generic).toBe(0);
});

test("shows Ghidra as shared with REA", async ({ page }) => {
  const controls = await fixture(
    page,
    installedCraft({ components: { ghidra: { shared: true } } }),
  );
  const dialog = await openDialog(page, "Manage");
  const ghidra = dialog.getByRole("checkbox", { name: ghidraRow });
  await expect(ghidra).toBeChecked();
  await expect(dialog).toContainText("Shared with REA");
  // Ghidra is installed already: nothing of it to download.
  await expect(dialog.locator(".rea-total")).toHaveText(craftOnly);
  await expect(dialog.getByRole("checkbox", { name: /I understand/ })).toHaveCount(0);
  await ghidra.uncheck();
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await expect.poll(() => controls.applied.length).toBe(1);
  expect(controls.applied[0]).toEqual({
    components: { ghidra: false },
    settings: { mode: "clean-room" },
  });
});

test("a first install ticks REA's Ghidra, which costs nothing", async ({ page }) => {
  await fixture(
    page,
    craftState({
      components: {
        ghidra: {
          installed: true,
          shared: true,
          version: reaManifest.ghidra.version,
          jdkVersion: reaManifest.jdk.version,
        },
      },
    }),
  );
  const dialog = await openDialog(page);
  await expect(dialog.getByRole("checkbox", { name: ghidraRow })).toBeChecked();
  await expect(dialog).toContainText("Shared with REA");
  await expect(dialog.locator(".rea-total")).toHaveText(craftOnly);
});

test("the Ghidra box follows Craft Anything's own choice, not what REA keeps", async ({
  page,
}) => {
  await fixture(
    page,
    installedCraft({ components: { ghidra: { wanted: false, shared: true } } }),
  );
  const dialog = await openDialog(page, "Manage");
  await expect(dialog.getByRole("checkbox", { name: ghidraRow })).not.toBeChecked();
});

test("switches deep mode for sessions", async ({ page }) => {
  const controls = await fixture(page, installedCraft());
  const dialog = await openDialog(page, "Manage");
  const deep = dialog.getByRole("switch", { name: "Deep mode for sessions" });
  await expect(deep).not.toBeChecked();
  await deep.check();
  await dialog.getByRole("button", { name: "Apply changes" }).click();
  await expect.poll(() => controls.applied.length).toBe(1);
  expect(controls.applied[0]).toEqual({
    components: { ghidra: true },
    settings: { mode: "deep" },
  });
});

test("offers update when outdated", async ({ page }) => {
  const controls = await fixture(
    page,
    installedCraft({
      updateAvailable: true,
      components: { core: { version: "0.4.0", outdated: true } },
    }),
  );
  await expect(card(page)).toContainText("Update available");
  await expect(card(page)).toContainText("0.4.0");
  const dialog = await openDialog(page, "Manage");
  await expect(dialog).toContainText(
    `An update is available: Craft Anything ${craftManifest.version}.`,
  );
  await dialog.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(() => controls.updates).toBe(1);
});

test("names the version running sessions keep until they reload", async ({ page }) => {
  await fixture(
    page,
    installedCraft({ components: { core: { runningVersions: ["0.4.0"] } } }),
  );
  const dialog = await openDialog(page, "Manage");
  await expect(dialog).toContainText(
    "Running sessions keep using version 0.4.0 until they reload.",
  );
});

test("names a session that could not switch to the installed version", async ({
  page,
}) => {
  await fixture(
    page,
    installedCraft({ components: { core: { swapFailures: ["cli: exited (3)"] } } }),
  );
  const dialog = await openDialog(page, "Manage");
  await expect(dialog).toContainText(
    "Running sessions could not switch to the installed version and keep their previous one: cli: exited (3)",
  );
});

test("removes", async ({ page }) => {
  const controls = await fixture(page, installedCraft(), {
    uninstall: {
      status: 409,
      json: {
        error:
          "Gerade läuft ein Nachbau mit Craft Anything. Warte, bis er fertig ist, oder pausiere ihn, bevor du Craft Anything oder seine Bestandteile entfernst, änderst oder aktualisierst.",
        messageKey: "craft.inUse",
      },
    },
  });
  const dialog = await openDialog(page, "Manage");
  await dialog.getByRole("button", { name: "Remove Craft Anything" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove Craft Anything?" });
  await expect(confirm).toContainText("REA");
  await confirm.getByRole("button", { name: "Remove now", exact: true }).click();
  await expect.poll(() => controls.removes).toBe(1);
  await expect(confirm).toContainText(
    "Running sessions keep the tools until they reload.",
  );
  await expect(confirm.getByRole("alert")).toContainText(
    "A rebuild is running with Craft Anything",
  );
});

test("the start page row opens Craft Anything's dialog, never the installer", async ({
  page,
}) => {
  const controls = await fixture(
    page,
    installedCraft({
      updateAvailable: true,
      components: { core: { version: "0.4.0", outdated: true } },
    }),
    { path: "/" },
  );
  const row = page
    .getByRole("region", { name: /Your tools/ })
    .locator(".start-tool")
    .filter({ has: page.getByText("Craft Anything", { exact: true }) });
  await expect(row).toContainText("Update available · 0.4.0");
  await row.getByRole("button", { name: "Manage: Craft Anything", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Craft Anything" })).toBeVisible();
  expect(controls.generic).toBe(0);
});

test("managed row shows Manage Craft Anything and is read-only", async ({ page }) => {
  const managed = {
    id: "s1",
    name: "craft-anything",
    transport: "stdio",
    command: "/data/clis/craft-anything/0.5.0/craft-anything-cli",
    args: ["mcp", "--restricted", "--allow-web", "--allow-capture", "--clean-room"],
    headerNames: [],
    envNames: ["CRAFT_ANYTHING_CONFIG_DIR", "CRAFT_ANYTHING_NO_KEYCHAIN", "MY_KEY"],
    revision: 3,
    clis: ["claude"],
    cliStatus: {},
    managed: {
      tool: "craft-anything",
      lockedEnv: ["CRAFT_ANYTHING_CONFIG_DIR", "CRAFT_ANYTHING_NO_KEYCHAIN"],
    },
  };
  await wizardSetup(page, { servers: [managed] });
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.goto(`${base}/accounts?section=mcp-servers&item=s1`);
  const view = page.locator(".accounts-detail");
  await expect(
    view.getByRole("heading", { name: "craft-anything" }).first(),
  ).toBeVisible();
  await expect(view.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await expect(view.getByText(/together with Craft Anything/)).toBeVisible();
  const link = view.getByRole("link", { name: "Manage Craft Anything" });
  await expect(link).toHaveAttribute("href", /\/coding\/clis$/);
  await expect(
    view.getByRole("region", { name: "Source and name" }).getByRole("button"),
  ).toHaveCount(0);
  await view.getByRole("button", { name: "Change: Settings" }).click();
  const rows = page.locator(".accounts-detail .mcp-row");
  const locked = rows.filter({ hasText: "CRAFT_ANYTHING_CONFIG_DIR" });
  await expect(locked).toContainText("managed by AgentPier");
  await expect(locked.locator("input")).toHaveCount(0);
  await expect(locked.getByRole("button")).toHaveCount(0);
});

test("the dialog's footer buttons stay whole on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, installedCraft({ updateAvailable: true }));
  const dialog = await openDialog(page, "Manage");
  const footer = dialog.locator(".dialog-actions");
  await footer.scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".cache/craft-anything-dialog-phone-en.png" });
  const layout = await footer.evaluate((element) => {
    const box = (node) => node.getBoundingClientRect().toJSON();
    return {
      footer: box(element),
      width: innerWidth,
      buttons: [...element.querySelectorAll("button")]
        .filter((node) => node.getClientRects().length)
        .map((node) => ({
          text: node.textContent.trim(),
          ...box(node),
          clipped: node.scrollWidth > node.clientWidth,
        })),
    };
  });
  expect(layout.buttons.map((button) => button.text)).toEqual([
    "Remove Craft Anything",
    "Close",
    "Update",
    "Apply changes",
  ]);
  for (const button of layout.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(layout.footer.left);
    expect(button.right).toBeLessThanOrEqual(layout.width);
    expect(button.clipped).toBe(false);
  }
  // No two buttons overlap.
  for (const [index, a] of layout.buttons.entries())
    for (const b of layout.buttons.slice(index + 1))
      expect(
        a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
      ).toBe(true);
});

test("an unavailable host names the reason and offers no install", async ({ page }) => {
  await fixture(
    page,
    craftState({
      available: false,
      reason: "Craft Anything gibt es nur für macOS und Linux auf arm64 oder x64.",
      reasonKey: "craft.platformUnavailable",
    }),
  );
  const dialog = await openDialog(page);
  await expect(dialog).toContainText(
    "Craft Anything is only available for macOS and Linux on arm64 or x64.",
  );
  await expect(dialog.getByRole("button", { name: "Install", exact: true })).toHaveCount(
    0,
  );
});
