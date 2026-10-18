import { test, expect } from "@playwright/test";
import { openAccountItem } from "../helpers/accounts-browser.js";
import { baseURL } from "../helpers/browser.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { englishServerMessages } from "../../server/lib/i18n/catalog-en.js";
import { openAdd } from "./mcp-cli-fixture.js";
import {
  acceptCreate,
  choosePackage,
  packagedServer,
  packageSetup,
  preview,
  pypiVersions,
  toInstall,
  writes,
} from "./mcp-packages-fixture.js";

const screens = process.env.MCP_PACKAGE_SCREENS;
const wheelDigest = "85540ca61ed3cc27731471c45e1c74fb0a888827fb145bc58ce3a2104d243d19";
const sdistDigest = "0f".repeat(32);

/** A PyPI preview: three release files, the pure wheel installs. */
const pypiPreview = (extra = {}) =>
  preview({
    registry: "pypi",
    name: "opnsense-mcp-server",
    version: "0.4.1",
    integrity: [wheelDigest, sdistDigest, "1a".repeat(32)]
      .map((digest) => `sha256:${digest}`)
      .join(" "),
    installFile: {
      filename: "opnsense_mcp_server-0.4.1-py3-none-any.whl",
      sha256: wheelDigest,
    },
    dependencies: [
      { name: "fastmcp", version: "3.2.0", path: "fastmcp" },
      { name: "opnsense-mcp-server", version: "0.4.1", path: "opnsense-mcp-server" },
    ],
    programs: ["opnsense-mcp"],
    constraints: ["fastmcp<4"],
    ...extra,
  });

/** A packaged PyPI server with a stored constraint. */
const pypiServer = () => {
  const server = packagedServer("ready");
  return {
    ...server,
    source: {
      ...server.source,
      registry: "pypi",
      name: "opnsense-mcp-server",
      version: "0.4.0",
      program: "opnsense-mcp",
      constraints: ["fastmcp<4"],
    },
  };
};

/** The wizard's package step for a PyPI package, with its options unfolded. */
async function choosePypi(wizard, name = "opnsense-mcp-server", serverName = "opnsense") {
  await choosePackage(wizard);
  await wizard.getByRole("radio", { name: "PyPI" }).check();
  await wizard.getByLabel("Package", { exact: true }).fill(name);
  await wizard.getByLabel("Name", { exact: true }).fill(serverName);
  await wizard.getByText("More options").click();
}

test("a PyPI package shows withdrawn versions and installs with a constraint", async ({
  page,
}) => {
  const state = await packageSetup(page);
  state.versions = pypiVersions;
  state.preview = pypiPreview();
  acceptCreate(state);
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await choosePackage(dialog);
  await dialog.getByText("More options").click();
  await expect(dialog.getByLabel("Dependency constraints")).toHaveCount(0);
  await dialog.getByRole("radio", { name: "PyPI" }).check();
  await expect(dialog.getByLabel("Package", { exact: true })).toHaveAttribute(
    "placeholder",
    "mcp-server-name",
  );
  await dialog.getByLabel("Package", { exact: true }).fill("opnsense-mcp-server");
  await dialog.getByLabel("Name", { exact: true }).fill("opnsense");
  const version = dialog.getByLabel("Version", { exact: true });
  await expect(version).toHaveValue("0.4.1");
  await expect(version.locator("option")).toHaveCount(2);
  await expect(version.locator("option").nth(1)).toContainText("withdrawn by its author");
  // PEP 440 prereleases hide behind the same toggle.
  await dialog.getByLabel("Show prereleases").check();
  await expect(version.locator("option").first()).toContainText("0.5.0rc1 ·");
  await expect(version.locator("option").first()).toContainText("prerelease");
  await dialog.getByLabel("Dependency constraints").fill("  fastmcp<4\n\n");
  const confirm = await toInstall(dialog);
  await expect(confirm.getByText("PyPI", { exact: true })).toBeVisible();
  await expect(confirm.getByText("fastmcp<4", { exact: true })).toBeVisible();
  // Every release file is pinned; the digest shown is the file expected to install.
  await expect(confirm.getByText("3 files", { exact: true })).toBeVisible();
  await expect(
    confirm.getByText("Expected: opnsense_mcp_server-0.4.1-py3-none-any.whl"),
  ).toBeVisible();
  await expect(confirm.getByText(`sha256:${wheelDigest}`, { exact: true })).toBeVisible();
  await expect(confirm.getByText("opnsense-mcp", { exact: true })).toHaveCount(0);
  if (screens) await dialog.screenshot({ path: `${screens}/en-pypi-confirm.png` });
  expect(state.requests.find((r) => r.path.endsWith("/preview")).body).toEqual({
    registry: "pypi",
    name: "opnsense-mcp-server",
    version: "0.4.1",
    allowScripts: false,
    constraints: ["fastmcp<4"],
  });
  await confirm.getByRole("button", { name: "Install" }).click();
  await expect(dialog.getByText("Saved", { exact: true })).toBeVisible();
  expect(writes(state, "/api/mcp-servers")[0].body.source).toEqual({
    registry: "pypi",
    name: "opnsense-mcp-server",
    version: "0.4.1",
    allowScripts: false,
    constraints: ["fastmcp<4"],
  });
});

test("a refused constraint is named at its field", async ({ page }) => {
  const state = await packageSetup(page);
  state.versions = pypiVersions;
  state.preview = {
    status: 400,
    json: {
      code: "MCP_PACKAGE_INVALID",
      error:
        "Abhängigkeitsgrenzen nennen pro Zeile einen PyPI-Paketnamen mit Versionsgrenzen (zum Beispiel fastmcp<4), höchstens 10.",
      messageKey: "mcpPackages.invalidConstraints",
    },
  };
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await choosePypi(dialog);
  await expect(dialog.getByLabel("Version", { exact: true })).toHaveValue("0.4.1");
  const field = dialog.getByLabel("Dependency constraints");
  await field.fill("fastmcp[cli]<4");
  await toInstall(dialog);
  await expect(page).toHaveURL(/step=package/);
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("alert")).toHaveText(
    /^Dependency constraints take one PyPI package name with version limits per line/,
  );
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await field.fill("fastmcp<4");
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
});

test("a fully yanked version is named at the version field", async ({ page }) => {
  const state = await packageSetup(page);
  state.versions = pypiVersions;
  state.preview = {
    status: 400,
    json: {
      code: "MCP_PACKAGE_VERSION_YANKED",
      error:
        "Die Maintainer haben diese Version zurückgezogen (yanked). Bitte eine andere Version wählen.",
      messageKey: "mcpPackages.versionYanked",
    },
  };
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await choosePypi(dialog);
  const version = dialog.getByLabel("Version", { exact: true });
  await expect(version).toHaveValue("0.4.1");
  await toInstall(dialog);
  await expect(page).toHaveURL(/step=package/);
  await expect(version).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("alert")).toHaveText(
    "The maintainers withdrew (yanked) this version. Choose another version.",
  );
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("unsatisfiable limits are named at the constraints field, other failures at the install", async ({
  page,
}) => {
  const state = await packageSetup(page);
  state.versions = pypiVersions;
  state.preview = {
    status: 400,
    json: {
      code: "MCP_PACKAGE_UNSATISFIABLE",
      error: serverMessages.mcpPackages.unsatisfiable,
      messageKey: "mcpPackages.unsatisfiable",
    },
  };
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await choosePypi(dialog);
  await expect(dialog.getByLabel("Version", { exact: true })).toHaveValue("0.4.1");
  const field = dialog.getByLabel("Dependency constraints");
  await field.fill("fastmcp<1");
  await toInstall(dialog);
  await expect(page).toHaveURL(/step=package/);
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("alert")).toHaveText(
    englishServerMessages.mcpPackages.unsatisfiable,
  );
  await field.fill("fastmcp<4");
  state.preview = {
    status: 502,
    json: {
      code: "MCP_PACKAGE_INSTALL_FAILED",
      error: serverMessages.mcpPackages.previewFailed,
      messageKey: "mcpPackages.previewFailed",
    },
  };
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
  await toInstall(dialog);
  await expect(page).toHaveURL(/step=install/);
  await expect(
    page.getByText(englishServerMessages.mcpPackages.previewFailed),
  ).toBeVisible();
});

test("a package that is built first names its program and the build tools", async ({
  page,
}) => {
  const state = await packageSetup(page);
  state.versions = pypiVersions;
  state.preview = pypiPreview({
    programs: [],
    needsScripts: true,
    constraints: [],
    installFile: { filename: "old_x-0.4.1.tar.gz", sha256: sdistDigest },
  });
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await choosePypi(dialog, "old-x", "old");
  await expect(dialog.getByLabel("Version", { exact: true })).toHaveValue("0.4.1");
  await dialog.getByLabel("Allow install scripts or source builds").check();
  // The form's warning names the build tools as well.
  await expect(dialog.getByText(/Build tools such as setuptools/)).toBeVisible();
  const confirm = await toInstall(dialog);
  await expect(confirm.getByText("The program is chosen after the build.")).toBeVisible();
  await expect(confirm.getByText(/Build tools such as setuptools/)).toBeVisible();
  await expect(confirm.getByText(/not part of the frozen, hash-checked/)).toBeVisible();
  await expect(confirm.getByText("Expected build from old_x-0.4.1.tar.gz")).toBeVisible();
  await expect(confirm.getByText(`sha256:${sdistDigest}`)).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Install" })).toBeEnabled();
});

test("an npm package names no build tools and takes no constraints", async ({ page }) => {
  const state = await packageSetup(page);
  state.preview = preview({ needsScripts: true });
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await choosePackage(dialog);
  await dialog.getByLabel("Package", { exact: true }).fill("server-x");
  await dialog.getByLabel("Name", { exact: true }).fill("pkg");
  await expect(dialog.getByLabel("Version", { exact: true })).toHaveValue("1.1.0");
  await dialog.getByText("More options").click();
  await expect(dialog.getByLabel("Dependency constraints")).toHaveCount(0);
  await dialog.getByLabel("Allow install scripts or source builds").check();
  await expect(dialog.getByText(/Build tools/)).toHaveCount(0);
  const confirm = await toInstall(dialog);
  await expect(confirm.getByText(/scripts and source builds are allowed/)).toBeVisible();
  await expect(confirm.getByText(/Build tools/)).toHaveCount(0);
  await expect(confirm.getByText("sha512-abcdefghijklmnopq…")).toBeVisible();
  await expect(confirm.getByText(/files$/)).toHaveCount(0);
});

test("the PyPI panel shows its constraints and program and keeps them on update", async ({
  page,
}) => {
  const state = await packageSetup(page, { servers: [pypiServer()] });
  state.versions = pypiVersions;
  state.preview = pypiPreview({ diff: { added: [], removed: [], changed: [] } });
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
  await expect(panel.getByRole("list", { name: "Constraints" })).toHaveText("fastmcp<4");
  await expect(panel.getByText("opnsense-mcp", { exact: true })).toBeVisible();
  const field = panel.getByLabel("Dependency constraints");
  await expect(field).toHaveValue("fastmcp<4");
  await expect(panel.getByLabel("New version", { exact: true })).toHaveValue("0.4.1");
  await panel.getByRole("button", { name: "Check update" }).click();
  let confirm = panel.getByRole("alertdialog", { name: "Update this package?" });
  await expect(confirm.getByText("fastmcp<4", { exact: true })).toBeVisible();
  expect(state.requests.find((r) => r.path.endsWith("/preview")).body).toMatchObject({
    registry: "pypi",
    serverId: "s1",
    version: "0.4.1",
    constraints: ["fastmcp<4"],
  });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  // The same version with edited constraints is an update of its own.
  await panel.getByLabel("New version", { exact: true }).selectOption("0.4.0");
  const check = panel.getByRole("button", { name: "Check update" });
  await expect(check).toBeDisabled();
  await field.fill("fastmcp<4\nhttpx<1");
  await expect(check).toBeEnabled();
  await check.click();
  confirm = panel.getByRole("alertdialog", { name: "Update this package?" });
  await confirm.getByRole("button", { name: "Update" }).click();
  expect(writes(state, "/api/mcp-servers/s1/package/update")[0].body).toEqual({
    version: "0.4.0",
    allowScripts: false,
    constraints: ["fastmcp<4", "httpx<1"],
    previewId: "p1",
    confirmInstall: true,
  });
});

test("German: the panel of a PyPI package names its constraints and program", async ({
  page,
}) => {
  const state = await packageSetup(page, { language: "de", servers: [pypiServer()] });
  state.versions = pypiVersions;
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const panel = dialog.getByRole("region", { name: "Paket" });
  await expect(
    panel.getByRole("status").filter({ hasText: "Installiert" }),
  ).toBeVisible();
  await expect(panel.getByRole("list", { name: "Grenzen" })).toHaveText("fastmcp<4");
  await expect(panel.getByText("Programm", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("Abhängigkeitsgrenzen")).toHaveValue("fastmcp<4");
  await expect(
    panel.getByLabel("Neue Version", { exact: true }).locator("option", {
      hasText: "installiert",
    }),
  ).toHaveText(/^0\.4\.0 · .* · vom Autor zurückgezogen · installiert$/);
  if (screens) await panel.screenshot({ path: `${screens}/de-pypi-status-panel.png` });
});

test("on a phone the PyPI confirmation wraps its digest within the width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await packageSetup(page);
  state.versions = pypiVersions;
  state.preview = pypiPreview();
  await page.goto(baseURL + "/accounts");
  const dialog = await openAdd(page);
  await choosePypi(dialog);
  await expect(dialog.getByLabel("Version", { exact: true })).toHaveValue("0.4.1");
  await dialog.getByLabel("Dependency constraints").fill("fastmcp<4");
  const confirm = await toInstall(dialog);
  await expect(confirm.getByText(`sha256:${wheelDigest}`)).toBeVisible();
  const overflow = (locator) =>
    locator.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(await overflow(confirm)).toBeLessThanOrEqual(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  const box = await confirm.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  if (screens) await confirm.screenshot({ path: `${screens}/en-pypi-phone.png` });
});

test("a build with several programs waits for the program choice", async ({ page }) => {
  const server = pypiServer();
  server.source = { ...server.source, status: "choosing", program: "", leadingArgs: 0 };
  const state = await packageSetup(page, { servers: [server] });
  state.versions = pypiVersions;
  state.packageStatus = {
    source: server.source,
    job: { kind: "install", state: "done", code: null, log: "" },
    error: null,
    programs: ["opnsense-mcp", "opnsense-admin"],
  };
  state.reply = ({ path }) =>
    path.endsWith("/package/program")
      ? {
          status: 202,
          json: { job: { kind: "activate", state: "running", code: null, log: "" } },
        }
      : null;
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const panel = dialog.getByRole("region", { name: "Package" });
  await expect(
    panel.getByRole("status").filter({ hasText: "Choose program" }),
  ).toBeVisible();
  await expect(panel.getByText(/several programs/)).toBeVisible();
  // No update is offered while the build waits for its program.
  await expect(panel.getByRole("button", { name: "Check update" })).toHaveCount(0);
  const select = panel.getByLabel("Program", { exact: true });
  await expect(select).toHaveValue("opnsense-mcp");
  await select.selectOption("opnsense-admin");
  if (screens) await panel.screenshot({ path: `${screens}/en-pypi-choosing.png` });
  await panel.getByRole("button", { name: "Use this program" }).click();
  await expect(
    panel.getByRole("status").filter({ hasText: "Installing …" }),
  ).toBeVisible();
  expect(writes(state, "/api/mcp-servers/s1/package/program")[0].body).toEqual({
    program: "opnsense-admin",
  });
  // The bindings stay locked until the program runs.
  await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1&step=connect`);
  await expect(
    dialog.getByText(/added once the package is installed/).first(),
  ).toBeVisible();
});

test("a refused program choice names the reason and keeps the choice", async ({
  page,
}) => {
  const server = pypiServer();
  server.source = { ...server.source, status: "choosing", program: "", leadingArgs: 0 };
  const state = await packageSetup(page, { servers: [server] });
  state.versions = pypiVersions;
  state.packageStatus = {
    source: server.source,
    job: null,
    error: null,
    programs: ["opnsense-mcp", "opnsense-admin"],
  };
  state.reply = ({ path }) =>
    path.endsWith("/package/program")
      ? {
          status: 409,
          json: {
            code: "MCP_PACKAGE_BUSY",
            error: serverMessages.mcpPackages.busy,
            messageKey: "mcpPackages.busy",
          },
        }
      : null;
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const panel = dialog.getByRole("region", { name: "Package" });
  const select = panel.getByLabel("Program", { exact: true });
  await select.selectOption("opnsense-admin");
  await panel.getByRole("button", { name: "Use this program" }).click();
  await expect(panel.getByText(englishServerMessages.mcpPackages.busy)).toBeVisible();
  expect(writes(state, "/api/mcp-servers/s1/package/program")).toHaveLength(1);
  await expect(
    panel.getByRole("status").filter({ hasText: "Choose program" }),
  ).toBeVisible();
  await expect(select).toHaveValue("opnsense-admin");
  await expect(panel.getByRole("button", { name: "Use this program" })).toBeEnabled();
});

test("German: the program choice is translated", async ({ page }) => {
  const server = pypiServer();
  server.source = { ...server.source, status: "choosing", program: "", leadingArgs: 0 };
  const state = await packageSetup(page, { servers: [server], language: "de" });
  state.versions = pypiVersions;
  state.packageStatus = {
    source: server.source,
    job: null,
    error: null,
    programs: ["opnsense-mcp", "opnsense-admin"],
  };
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const panel = dialog.getByRole("region", { name: "Paket" });
  await expect(
    panel.getByRole("status").filter({ hasText: "Programm wählen" }),
  ).toBeVisible();
  await expect(panel.getByText(/mehrere Programme/)).toBeVisible();
  await expect(panel.getByLabel("Programm", { exact: true })).toHaveValue("opnsense-mcp");
  await expect(
    panel.getByRole("button", { name: "Dieses Programm verwenden" }),
  ).toBeVisible();
});

test("a waiting build whose programs are gone offers only Reinstall", async ({
  page,
}) => {
  const server = pypiServer();
  server.source = { ...server.source, status: "choosing", program: "", leadingArgs: 0 };
  const state = await packageSetup(page, { servers: [server] });
  state.versions = pypiVersions;
  state.packageStatus = { source: server.source, job: null, error: null, programs: [] };
  await page.goto(baseURL + "/accounts");
  const dialog = await openAccountItem(page, "pkg");
  const panel = dialog.getByRole("region", { name: "Package" });
  await expect(
    panel.getByRole("status").filter({ hasText: "Choose program" }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Reinstall" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Use this program" })).toHaveCount(0);
});
