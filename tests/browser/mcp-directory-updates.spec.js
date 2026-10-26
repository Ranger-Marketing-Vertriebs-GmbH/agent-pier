import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { packagedServer, versions } from "./mcp-packages-fixture.js";
import { directorySetup, dto } from "./mcp-directory-fixture.js";

const fromDirectory = () =>
  packagedServer("ready", {
    name: "opnsense",
    source: {
      registry: "npm",
      name: "server-x",
      version: "1.0.0",
      status: "ready",
      leadingArgs: 1,
    },
    directoryOrigin: { name: dto.opnsense.name, version: "1.0.0" },
    envNames: ["OPNSENSE_API_KEY", "EXTRA"],
  });

// The server's row in the Zugänge MCP list; its status names an available update.
const row = (page) =>
  page
    .locator(".long-list-row")
    .filter({ has: page.getByRole("button", { name: "opnsense", exact: true }) });

for (const [label, use] of [
  ["desktop", {}],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
]) {
  test.describe(label, () => {
    test.use(use);

    test("a newer directory version shows a pill and pre-fills the update", async ({
      page,
    }) => {
      const state = await directorySetup(page, {
        servers: [fromDirectory()],
        versions,
        directory: { updates: [{ serverId: "s1", version: "1.1.0" }] },
      });
      await page.goto(`${baseURL}/accounts?section=mcp-servers`);
      await expect(row(page).getByText("Update available")).toBeVisible();
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
      const panel = page.locator(".mcp-package");
      await expect(
        panel.getByText("Version 1.1.0 is listed in the directory."),
      ).toBeVisible();
      await expect(panel.locator(".mcp-package-update select")).toHaveValue("1.1.0");
      expect(state.requests.some((r) => r.path === "/api/mcp-directory/updates")).toBe(
        true,
      );
    });

    test("a listed version the registry does not list is not named", async ({ page }) => {
      await directorySetup(page, {
        servers: [fromDirectory()],
        versions,
        directory: { updates: [{ serverId: "s1", version: "1.2.0" }] },
      });
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
      const panel = page.locator(".mcp-package");
      await expect(panel.locator(".mcp-package-update select")).toHaveValue("1.1.0");
      await expect(panel.getByText(/is listed in the directory/)).toHaveCount(0);
    });

    test("a changed identifier is a hint, never a pre-filled version", async ({
      page,
    }) => {
      await directorySetup(page, {
        servers: [fromDirectory()],
        versions,
        directory: { updates: [{ serverId: "s1", hint: "identifier" }] },
      });
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
      await expect(
        page.getByText(/now lists another package for this server/),
      ).toBeVisible();
      await expect(page.getByText(/is listed in the directory/)).toHaveCount(0);
      await page.goto(`${baseURL}/accounts?section=mcp-servers`);
      await expect(row(page)).toBeVisible();
      await expect(row(page).getByText("Update available")).toHaveCount(0);
    });

    test("a changed address is a hint and shows no pill", async ({ page }) => {
      await directorySetup(page, {
        servers: [fromDirectory()],
        versions,
        directory: { updates: [{ serverId: "s1", hint: "remote" }] },
      });
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
      await expect(
        page.getByText("The directory now lists another address for this server."),
      ).toBeVisible();
      await page.goto(`${baseURL}/accounts?section=mcp-servers`);
      await expect(row(page)).toBeVisible();
      await expect(row(page).getByText("Update available")).toHaveCount(0);
    });

    test("once the listed version is installed, pill and hint are gone", async ({
      page,
    }) => {
      const state = await directorySetup(page, {
        servers: [fromDirectory()],
        versions,
        directory: { updates: [{ serverId: "s1", version: "1.1.0" }] },
      });
      const base = state.handle;
      state.handle = async (context) => {
        if (context.path.endsWith("/package/update"))
          return context.route.fulfill({
            status: 202,
            json: { job: { kind: "update", state: "running", code: null, log: "" } },
          });
        if (context.path.endsWith("/package") && state.packageStatus)
          return context.route.fulfill({ json: state.packageStatus });
        return base(context);
      };
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
      const panel = page.locator(".mcp-package");
      const hint = panel.getByText("Version 1.1.0 is listed in the directory.");
      await expect(hint).toBeVisible();
      await panel.getByRole("button", { name: "Check update" }).click();
      await panel
        .getByRole("alertdialog", { name: "Update this package?" })
        .getByRole("button", { name: "Update" })
        .click();
      // The directory still answers with the stale update; the installed version wins.
      const updated = fromDirectory();
      updated.source = { ...updated.source, version: "1.1.0" };
      updated.revision = (updated.revision ?? 0) + 1;
      state.servers = [updated];
      state.packageStatus = {
        source: updated.source,
        job: { kind: "update", state: "done", code: 0, log: "" },
        error: null,
      };
      await expect(panel.getByText("server-x@1.1.0")).toBeVisible();
      await expect(hint).toHaveCount(0);
      const pill = row(page).getByText("Update available");
      await page.goto(`${baseURL}/accounts?section=mcp-servers`);
      await expect(row(page)).toBeVisible();
      await expect(pill).toHaveCount(0);
    });

    test("a version newer than the listed one drops the hint and asks again", async ({
      page,
    }) => {
      const state = await directorySetup(page, {
        servers: [fromDirectory()],
        versions,
        directory: { updates: [{ serverId: "s1", version: "1.1.0" }] },
      });
      const asked = () =>
        state.requests.filter((r) => r.path === "/api/mcp-directory/updates").length;
      const base = state.handle;
      state.handle = async (context) => {
        if (context.path.endsWith("/package/update"))
          return context.route.fulfill({
            status: 202,
            json: { job: { kind: "update", state: "running", code: null, log: "" } },
          });
        if (context.path.endsWith("/package") && state.packageStatus)
          return context.route.fulfill({ json: state.packageStatus });
        return base(context);
      };
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1`);
      const panel = page.locator(".mcp-package");
      const hint = panel.getByText("Version 1.1.0 is listed in the directory.");
      await expect(hint).toBeVisible();
      const before = asked();
      await panel.getByRole("button", { name: "Check update" }).click();
      await panel
        .getByRole("alertdialog", { name: "Update this package?" })
        .getByRole("button", { name: "Update" })
        .click();
      // The package ends up newer than the listed version; the directory no longer
      // reports an update for it.
      const updated = fromDirectory();
      updated.source = { ...updated.source, version: "1.2.0" };
      updated.revision = (updated.revision ?? 0) + 1;
      state.servers = [updated];
      state.directory.updates = [];
      state.packageStatus = {
        source: updated.source,
        job: { kind: "update", state: "done", code: 0, log: "" },
        error: null,
      };
      await expect(panel.getByText("server-x@1.2.0")).toBeVisible();
      await expect(hint).toHaveCount(0);
      await expect.poll(asked).toBeGreaterThan(before);
    });

    test("edit settings marks the directory's required names", async ({ page }) => {
      await directorySetup(page, { servers: [fromDirectory()] });
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1&step=settings`);
      const key = page.locator(".mcp-row", { hasText: "OPNSENSE_API_KEY" });
      await expect(key.getByText("Required")).toBeVisible();
      await expect(
        page.locator(".mcp-row", { hasText: "EXTRA" }).getByText("Required"),
      ).toHaveCount(0);
    });

    test("edit settings marks the names of the package the server runs", async ({
      page,
    }) => {
      await directorySetup(page, { servers: [fromDirectory()] });
      const [first] = dto.opnsense.options;
      const entry = {
        ...dto.opnsense,
        options: [
          first,
          {
            ...first,
            identifier: "server-x",
            env: [{ ...first.env[1], name: "EXTRA" }],
          },
        ],
      };
      await page.route(/\/api\/mcp-directory\/servers\/.+/, (route) =>
        route.fulfill({ json: entry }),
      );
      await page.goto(`${baseURL}/accounts?section=mcp-servers&item=s1&step=settings`);
      await expect(
        page.locator(".mcp-row", { hasText: "EXTRA" }).getByText("Required"),
      ).toBeVisible();
      await expect(
        page.locator(".mcp-row", { hasText: "OPNSENSE_API_KEY" }).getByText("Required"),
      ).toHaveCount(0);
    });
  });
}
