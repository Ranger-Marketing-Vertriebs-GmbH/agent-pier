import { test, expect } from "@playwright/test";
import { accountDetail, openAccountItem, saveBar } from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { openAdd } from "./mcp-cli-fixture.js";
import { packagedServer, packageSetup, preview, writes } from "./mcp-packages-fixture.js";

const screens = process.env.MCP_PACKAGE_SCREENS;

/** POST /mcp-servers answers 202 with an installing packaged server. */
const acceptCreate = (state) => {
  state.reply = ({ path, method, body }) => {
    if (path !== "/api/mcp-servers" || method !== "POST") return null;
    const server = packagedServer("installing", {
      name: body.name,
      args: body.args || [],
      source: { ...body.source, status: "installing", leadingArgs: 0, errorCode: null },
    });
    state.servers = [server];
    state.packageStatus = {
      source: server.source,
      job: { kind: "install", state: "running", code: null, log: "" },
      error: null,
    };
    return { status: 202, json: server };
  };
};

async function choosePackage(dialog) {
  await dialog.getByRole("radio", { name: "Local command (stdio)" }).check();
  await dialog.getByRole("radio", { name: "Install package" }).check();
}

test("installing an npm package previews, confirms once and shows progress", async ({
  page,
}) => {
  const state = await packageSetup(page);
  acceptCreate(state);
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await dialog.getByLabel("Name", { exact: true }).fill("pkg");
  await choosePackage(dialog);
  await expect(dialog.getByRole("textbox", { name: /^Command/ })).toHaveCount(0);
  // exact: "Install package" (the source radio) also contains "Package".
  await dialog.getByLabel("Package", { exact: true }).fill("server-x");
  const version = dialog.getByLabel("Version", { exact: true });
  // Newest stable preselected; the prerelease hides, the deprecated one is marked.
  await expect(version).toHaveValue("1.1.0");
  await expect(version.locator("option")).toHaveCount(2);
  await expect(version.locator("option").nth(1)).toContainText("1.0.0");
  await expect(version.locator("option").nth(1)).toContainText("deprecated");
  await dialog.getByLabel("Show prereleases").check();
  await expect(version.locator("option")).toHaveCount(3);
  await expect(version.locator("option").first()).toContainText("prerelease");
  await dialog.getByRole("checkbox", { name: "Claude Code" }).check();
  await dialog.getByRole("button", { name: "Save server" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Install this package?" });
  await expect(confirm.getByText("server-x@1.1.0")).toBeVisible();
  await expect(confirm.getByText("sha512-abcdefghijklmnopq…")).toBeVisible();
  await confirm.getByText("2 packages in total").click();
  await expect(confirm.getByText("helper 1.0.0")).toBeVisible();
  // No stdio question besides this one, even with a CLI chosen.
  await expect(page.getByRole("alertdialog")).toHaveCount(1);
  if (screens)
    await accountDetail(page).screenshot({ path: `${screens}/en-install-confirm.png` });
  expect(state.requests.find((r) => r.path.endsWith("/preview")).body).toEqual({
    registry: "npm",
    name: "server-x",
    version: "1.1.0",
    allowScripts: false,
  });
  await confirm.getByRole("button", { name: "Install" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Installing…" }).first(),
  ).toBeVisible();
  const save = writes(state, "/api/mcp-servers")[0].body;
  expect(save).toMatchObject({
    confirmInstall: true,
    previewId: "p1",
    clis: ["claude"],
    source: { registry: "npm", name: "server-x", version: "1.1.0", allowScripts: false },
  });
  expect(save.confirmStdio).toBeUndefined();
  expect(save.command).toBeUndefined();
});

test("a package with several programs lets the confirmation choose one", async ({
  page,
}) => {
  const state = await packageSetup(page);
  state.preview = preview({ programs: ["server-x", "server-x-cli"] });
  acceptCreate(state);
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await dialog.getByLabel("Name", { exact: true }).fill("pkg");
  await choosePackage(dialog);
  await dialog.getByLabel("Package", { exact: true }).fill("server-x");
  await expect(dialog.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
  await dialog.getByRole("button", { name: "Save server" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Install this package?" });
  await confirm.getByLabel("Program").selectOption("server-x-cli");
  await confirm.getByRole("button", { name: "Install" }).click();
  await expect(saveBar(page)).toHaveCount(0);
  expect(writes(state, "/api/mcp-servers")[0].body.program).toBe("server-x-cli");
});

test("allowing scripts warns in the form and in the confirmation", async ({ page }) => {
  const state = await packageSetup(page);
  state.preview = preview({ needsScripts: true });
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await dialog.getByLabel("Name", { exact: true }).fill("pkg");
  await choosePackage(dialog);
  await dialog.getByLabel("Package", { exact: true }).fill("server-x");
  await expect(dialog.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
  await dialog.getByRole("button", { name: "Save server" }).click();
  let confirm = page.getByRole("alertdialog", { name: "Install this package?" });
  // A package that needs scripts cannot be confirmed without the opt-in.
  await expect(confirm.getByRole("alert")).toContainText("needs install scripts");
  await expect(confirm.getByRole("button", { name: "Install" })).toBeDisabled();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await dialog.getByLabel("Allow install scripts or source builds").check();
  await expect(
    dialog.getByText(/runs during installation with your user's rights/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Save server" }).click();
  confirm = page.getByRole("alertdialog", { name: "Install this package?" });
  await expect(confirm.getByText(/scripts and source builds are allowed/)).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Install" })).toBeEnabled();
  expect(state.requests.filter((r) => r.path.endsWith("/preview")).at(-1).body).toEqual(
    expect.objectContaining({ allowScripts: true }),
  );
});

test("an unknown package or an unreachable registry is named at the version", async ({
  page,
}) => {
  const state = await packageSetup(page);
  state.versions = {
    status: 404,
    json: {
      code: "MCP_PACKAGE_NOT_FOUND",
      error: "Dieses Paket gibt es in der gewählten Registry nicht.",
      messageKey: "mcpPackages.notFound",
    },
  };
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await choosePackage(dialog);
  await dialog.getByLabel("Package", { exact: true }).fill("no-such-server");
  const version = dialog.getByLabel("Version", { exact: true });
  await expect(version).toHaveAccessibleDescription(
    "This package does not exist in the selected registry.",
  );
  state.versions = {
    status: 502,
    json: {
      code: "MCP_PACKAGE_REGISTRY_UNAVAILABLE",
      error: "Die Registry ist gerade nicht erreichbar. Bitte später erneut versuchen.",
      messageKey: "mcpPackages.registryUnavailable",
    },
  };
  await dialog.getByLabel("Package", { exact: true }).fill("server-y");
  await expect(version).toHaveAccessibleDescription(
    "The registry is currently unreachable. Please try again later.",
  );
});

test("an update shows the lock diff before it is confirmed", async ({ page }) => {
  const state = await packageSetup(page, { servers: [packagedServer("ready")] });
  state.preview = preview({
    diff: {
      added: [{ name: "extra", version: "2.0.0" }],
      removed: [{ name: "old", version: "0.1.0" }],
      changed: [{ name: "helper", from: "0.9.0", to: "1.0.0" }],
    },
  });
  state.reply = ({ path }) =>
    path.endsWith("/package/update")
      ? {
          status: 202,
          json: { job: { kind: "update", state: "running", code: null, log: "" } },
        }
      : null;
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const panel = dialog.getByRole("region", { name: "Package" });
  await expect(panel.getByRole("status").filter({ hasText: "Installed" })).toBeVisible();
  const version = panel.getByLabel("New version", { exact: true });
  await expect(version).toHaveValue("1.1.0");
  await expect(version.locator("option", { hasText: "installed" })).toHaveText(
    /^1\.0\.0 · .* · deprecated · installed$/,
  );
  // Only the owner's argument is editable; the generated program path stays hidden.
  await expect(dialog.getByLabel("Arguments")).toHaveValue("--owner");
  await panel.getByRole("button", { name: "Check update" }).click();
  const confirm = panel.getByRole("alertdialog", { name: "Update this package?" });
  await expect(confirm.getByText("extra 2.0.0")).toBeVisible();
  await expect(confirm.getByText("old 0.1.0")).toBeVisible();
  await expect(confirm.getByText("helper 0.9.0 → 1.0.0")).toBeVisible();
  expect(state.requests.find((r) => r.path.endsWith("/preview")).body).toMatchObject({
    serverId: "s1",
    version: "1.1.0",
  });
  expect(writes(state, "/api/mcp-servers/s1/package/update")).toHaveLength(0);
  await confirm.getByRole("button", { name: "Update" }).click();
  await expect(
    panel.getByRole("status").filter({ hasText: "Installing…" }),
  ).toBeVisible();
  expect(writes(state, "/api/mcp-servers/s1/package/update")[0].body).toEqual({
    version: "1.1.0",
    allowScripts: false,
    previewId: "p1",
    confirmInstall: true,
  });
});

test("a packaged server switches back to an own command with its owner args", async ({
  page,
}) => {
  const state = await packageSetup(page, { servers: [packagedServer("ready")] });
  state.reply = ({ path, method }) =>
    path === "/api/mcp-servers/s1" && method === "PUT"
      ? { json: { ...state.servers[0], source: undefined, revision: 4 } }
      : null;
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  await dialog.getByRole("button", { name: "Use own command" }).click();
  await expect(dialog.getByText(/removes its installed package/)).toBeVisible();
  await dialog.getByRole("textbox", { name: /^Command/ }).fill("/usr/bin/server-x");
  await dialog.getByRole("button", { name: "Save server" }).click();
  await expect(saveBar(page)).toHaveCount(0);
  const body = writes(state, "/api/mcp-servers/s1")[0].body;
  expect(body).toEqual({
    revision: 3,
    source: null,
    command: "/usr/bin/server-x",
    args: ["--owner"],
  });
});

test("an own-command server switches to a package with one confirmation (D1)", async ({
  page,
}) => {
  const own = packagedServer("ready", {
    command: "/usr/bin/own",
    args: ["--x"],
    source: undefined,
  });
  const state = await packageSetup(page, { servers: [own] });
  state.reply = ({ path, method, body }) =>
    path === "/api/mcp-servers/s1" && method === "PUT"
      ? {
          status: 202,
          json: {
            ...own,
            source: { ...body.source, status: "installing", leadingArgs: 0 },
          },
        }
      : null;
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  await dialog.getByRole("radio", { name: "Install package" }).check();
  await dialog.getByLabel("Package", { exact: true }).fill("server-x");
  await expect(dialog.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
  await dialog.getByRole("button", { name: "Save server" }).click();
  await page
    .getByRole("alertdialog", { name: "Install this package?" })
    .getByRole("button", { name: "Install" })
    .click();
  await expect(saveBar(page)).toHaveCount(0);
  const body = writes(state, "/api/mcp-servers/s1")[0].body;
  expect(body).toEqual({
    revision: 3,
    source: { registry: "npm", name: "server-x", version: "1.1.0", allowScripts: false },
    confirmInstall: true,
    previewId: "p1",
  });
});

test("German: a failed package shows its error, log and Reinstall; bindings wait", async ({
  page,
}) => {
  const state = await packageSetup(page, {
    language: "de",
    servers: [packagedServer("failed")],
  });
  state.packageStatus = {
    source: state.servers[0].source,
    job: {
      kind: "install",
      state: "failed",
      code: "MCP_PACKAGE_INSTALL_FAILED",
      log: "npm error code E404\nnpm error 404 Not Found - GET <data>/server-x",
    },
    error: {
      code: "MCP_PACKAGE_INSTALL_FAILED",
      message: "Die Installation ist fehlgeschlagen. Details stehen im Protokoll.",
      messageKey: "mcpPackages.installFailed",
    },
  };
  state.reply = ({ path }) =>
    path.endsWith("/package/reinstall")
      ? {
          status: 202,
          json: { job: { kind: "reinstall", state: "running", code: null, log: "" } },
        }
      : null;
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const panel = dialog.getByRole("region", { name: "Paket" });
  await expect(
    panel.getByRole("status").filter({ hasText: "Installation fehlgeschlagen" }),
  ).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveText(
    "Die Installation ist fehlgeschlagen. Details stehen im Protokoll.",
  );
  const log = panel.getByText("Installationsprotokoll");
  await expect(panel.getByText(/npm error code E404/)).toBeHidden();
  await log.click();
  await expect(panel.getByText(/npm error code E404/)).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Claude Code" })).toBeDisabled();
  await expect(
    dialog.getByText(
      "Coding-CLIs und Agenten lassen sich hinzufügen, sobald das Paket installiert ist.",
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Eigenen Befehl verwenden" }),
  ).toBeVisible();
  if (screens) await panel.screenshot({ path: `${screens}/de-status-panel.png` });
  await panel.getByRole("button", { name: "Neu installieren" }).click();
  await expect(
    panel.getByRole("status").filter({ hasText: "Wird installiert…" }),
  ).toBeVisible();
  expect(writes(state, "/api/mcp-servers/s1/package/reinstall")).toHaveLength(1);
});

test("German: the form offers the package source", async ({ page }) => {
  await packageSetup(page, { language: "de" });
  await page.goto(baseURL + "/accounts");
  await page
    .getByRole("region", { name: "MCP-Server" })
    .getByRole("button", { name: "MCP-Server hinzufügen" })
    .click();
  const dialog = accountDetail(page);
  await dialog.getByRole("radio", { name: "Lokaler Befehl (stdio)" }).check();
  await dialog.getByRole("radio", { name: "Paket installieren" }).check();
  await expect(dialog.getByLabel("Paket", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Vorabversionen anzeigen")).toBeVisible();
});
