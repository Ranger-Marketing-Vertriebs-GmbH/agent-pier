import { navigateTo } from "../helpers/navigation.js";
import { test, expect } from "@playwright/test";
import { baseURL as base } from "../helpers/browser.js";
import {
  expectNoHorizontalOverflow,
  expectProfilesDisabled,
  emptyExtensions,
  openTab,
} from "../helpers/extensions.js";
async function setup(page, tool = "claude") {
  const writes = [];
  const account = { id: "fixture-" + tool, name: "Arbeit", kind: "managed", tool };
  const data = {
    tool,
    available: true,
    reason: null,
    note: "Änderungen gelten für neue Sitzungen.",
    busy: false,
    capabilities: {
      marketplaces: tool !== "opencode",
      enable: tool === "claude",
      update: tool === "claude",
      install: true,
    },
    installed: [],
    marketplaces: [],
    catalog: [],
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.pathname === "/api/state")
      return route.fulfill({
        json: {
          accounts: [account],
          tools: [{ id: tool, name: tool, installed: true }],
          sessions: [],
          home: "/fixture",
        },
      });
    if (url.pathname.endsWith("/plugins")) {
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        writes.push(body);
        if (body.action === "marketplace-add") {
          data.marketplaces = [{ name: "demo-market", source: body.source }];
          data.catalog = [
            {
              id: "demo@demo-market",
              name: "Demo",
              description: "Fixture plugin",
              marketplace: "demo-market",
              installed: false,
            },
          ];
        }
        if (body.action === "install") {
          data.installed = [
            {
              id: body.pluginId || body.source,
              name: "Demo",
              version: "1.0.0",
              enabled: true,
              scope: "user",
              removable: true,
            },
          ];
          data.catalog.forEach((p) => (p.installed = true));
        }
        if (body.action === "disable") data.installed[0].enabled = false;
        if (body.action === "remove") data.installed = [];
        if (body.action === "marketplace-remove") {
          data.marketplaces = data.marketplaces.filter(
            (m) => m.name !== body.marketplace,
          );
          data.catalog = data.catalog.filter((p) => p.marketplace !== body.marketplace);
        }
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: data });
    }
    if (url.pathname.endsWith("/extensions"))
      return route.fulfill({ json: emptyExtensions() });
    return route.fulfill({ json: {} });
  });
  await page.goto(base);
  if (await page.getByRole("button", { name: "Navigation öffnen" }).isVisible())
    await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await navigateTo(page, "Erweiterungen");
  const extensionsUrl = new URL(page.url());
  extensionsUrl.searchParams.set("tab", "plugins");
  await page.goto(extensionsUrl.toString());
  return { writes, data };
}
test("marketplace source, browse, install, disable and deliberate removal use selected CLI profile", async ({
  page,
}) => {
  const { writes } = await setup(page);
  expect(writes).toEqual([]);
  await expect(page.getByRole("tab")).toHaveText([
    /^MCP-Server/,
    /^Skills/,
    /^Plugins/,
    /^Marketplaces/,
  ]);
  await openTab(page, "Marketplaces");
  await expect(page).toHaveURL(/\?tab=marketplaces$/);
  await page.getByRole("button", { name: "Marketplace hinzufügen", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Marketplace hinzufügen" });
  await expect(panel).toContainText("Profil Arbeit");
  await panel.getByLabel("Marketplace-Quelle").fill("example/plugins");
  await panel
    .getByRole("button", { name: "Marketplace hinzufügen", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "demo-market", exact: true }),
  ).toBeVisible();
  await openTab(page, "Plugins");
  await page.getByRole("button", { name: "Plugins entdecken", exact: true }).click();
  await expect(page.getByRole("radio", { name: /^Entdecken/ })).toBeChecked();
  await expect(page.getByRole("heading", { name: "Demo", exact: true })).toBeVisible();
  await page.screenshot({
    path: "/tmp/agentpier-plugins-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Plugin Demo installieren" }).click();
  await page.getByRole("radio", { name: /^Installiert/ }).check();
  await expect(
    page.getByRole("button", { name: "Plugin Demo deaktivieren" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Plugin Demo deaktivieren" }).click();
  await expect(
    page.getByRole("button", { name: "Plugin Demo aktivieren" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Plugin Demo entfernen" }).click();
  expect(writes.at(-1).action).toBe("disable");
  await page.getByRole("button", { name: "Entfernen bestätigen", exact: true }).click();
  await expect(
    page.getByText("Noch keine Plugins installiert.", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([
    { action: "marketplace-add", source: "example/plugins" },
    { action: "install", pluginId: "demo@demo-market" },
    { action: "disable", pluginId: "demo@demo-market" },
    { action: "remove", pluginId: "demo@demo-market" },
  ]);
});
test("OpenCode installs explicit npm package and stays usable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { writes } = await setup(page, "opencode");
  await expect(page.getByRole("tab")).toHaveText([/^MCP-Server/, /^Skills/, /^Plugins/]);
  await expect(page.getByRole("radio", { name: /^Entdecken/ })).toHaveCount(0);
  await expect(page.getByLabel("Marketplace-Quelle")).toHaveCount(0);
  await page.getByRole("button", { name: "npm-Plugin hinzufügen", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "npm-Plugin hinzufügen" });
  await expectNoHorizontalOverflow(page);
  await panel.getByLabel("npm-Paket").fill("@example/plugin@1.2.3");
  await panel.getByRole("button", { name: "Paket installieren", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Demo", exact: true })).toBeVisible();
  expect(writes[0]).toEqual({ action: "install", source: "@example/plugin@1.2.3" });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: "/tmp/agentpier-plugins-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});
test("plugin failures preserve source draft and prevent duplicate requests", async ({
  page,
}) => {
  await setup(page);
  let release,
    calls = 0;
  const held = new Promise((r) => (release = r));
  await page.route("**/accounts/fixture-claude/plugins", async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    calls++;
    await held;
    return route.fulfill({
      status: 409,
      json: { error: "Marketplace nicht erreichbar" },
    });
  });
  await openTab(page, "Marketplaces");
  await page.getByRole("button", { name: "Marketplace hinzufügen", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Marketplace hinzufügen" });
  await panel.getByLabel("Marketplace-Quelle").fill("example/plugins");
  await panel
    .getByRole("button", { name: "Marketplace hinzufügen", exact: true })
    .click();
  await expectProfilesDisabled(page);
  await expect(panel.getByLabel("Marketplace-Quelle")).toBeDisabled();
  release();
  await expect(page.getByRole("alert")).toContainText("Marketplace nicht erreichbar");
  await expect(panel.getByLabel("Marketplace-Quelle")).toHaveValue("example/plugins");
  expect(calls).toBe(1);
});

test("marketplace removal reveals its confirmation and resets a removed catalog filter", async ({
  page,
}) => {
  const { data } = await setup(page);
  data.marketplaces = [
    { name: "A", source: "example/a" },
    { name: "B", source: "example/b" },
  ];
  data.catalog = [
    {
      id: "b@B",
      name: "Remaining plugin",
      marketplace: "B",
      description: "Visible after removal",
    },
  ];
  data.installed = Array.from({ length: 12 }, (_, i) => ({
    id: "installed-" + i,
    name: "Installed " + i,
    removable: true,
  }));
  await page.getByRole("button", { name: "Neu laden", exact: true }).click();
  await page.getByRole("radio", { name: /^Entdecken/ }).check();
  await page.getByLabel("Marketplace filtern").selectOption("A");
  await openTab(page, "Marketplaces");
  await page.getByRole("button", { name: "Marketplace A entfernen" }).click();
  const confirm = page.getByRole("group", { name: "Entfernen bestätigen" });
  await expect(confirm).toBeFocused();
  await expect(confirm).toBeInViewport();
  await page.getByRole("button", { name: "Entfernen bestätigen", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A", exact: true })).toHaveCount(0);
  await openTab(page, "Plugins");
  await expect(page.getByLabel("Marketplace filtern")).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Remaining plugin", exact: true }),
  ).toBeVisible();
});

test("large marketplace catalogs stay bounded while search includes all entries", async ({
  page,
}) => {
  const { data } = await setup(page);
  data.catalog = Array.from({ length: 130 }, (_, i) => ({
    id: "plugin-" + i + "@market",
    name: "Plugin " + i,
    marketplace: "market",
  }));
  await page.getByRole("button", { name: "Neu laden", exact: true }).click();
  await page.getByRole("radio", { name: "Entdecken · 130" }).check();
  await expect(
    page.getByRole("button", { name: /Plugin Plugin .* installieren/ }),
  ).toHaveCount(20);
  await page.getByRole("button", { name: "Plugin-Katalog: Nächste Seite" }).click();
  await expect(
    page.getByRole("button", { name: /Plugin Plugin .* installieren/ }),
  ).toHaveCount(20);
  await expect(
    page.getByRole("button", { name: "Plugin Plugin 20 installieren", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Plugins suchen", { exact: true }).fill("Plugin 129");
  await expect(
    page.getByRole("button", { name: "Plugin Plugin 129 installieren", exact: true }),
  ).toBeVisible();
});

test("installed plugin pagination searches every page and clamps after a smaller refresh", async ({
  page,
}) => {
  const { data } = await setup(page);
  data.installed = Array.from({ length: 41 }, (_, i) => ({
    id: "installed-" + i,
    name: "Installed " + i,
    removable: true,
  }));
  await page.getByRole("button", { name: "Neu laden", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Plugin Installed .* entfernen/ }),
  ).toHaveCount(20);
  await page.getByRole("button", { name: "Installierte Plugins: Nächste Seite" }).click();
  await expect(
    page.getByRole("heading", { name: "Installed 20", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Installierte Plugins suchen").fill("Installed 40");
  await expect(
    page.getByRole("heading", { name: "Installed 40", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Installierte Plugins suchen").fill("");
  await page.getByRole("button", { name: "Installierte Plugins: Nächste Seite" }).click();
  await page.getByRole("button", { name: "Installierte Plugins: Nächste Seite" }).click();
  data.installed = data.installed.slice(0, 1);
  await page.getByRole("button", { name: "Neu laden", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Installed 0", exact: true }),
  ).toBeVisible();
});

test("an earlier plugin error never appears in a newly opened add panel", async ({
  page,
}) => {
  const { data } = await setup(page);
  data.marketplaces = [{ name: "A", source: "example/a" }];
  let calls = 0;
  await page.route("**/accounts/fixture-claude/plugins", async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    calls++;
    const { action } = route.request().postDataJSON();
    return route.fulfill({
      status: 409,
      json: {
        error:
          action === "marketplace-update"
            ? "Aktualisierung fehlgeschlagen"
            : "Marketplace nicht erreichbar",
      },
    });
  });
  await page.getByRole("button", { name: "Neu laden", exact: true }).click();
  await openTab(page, "Marketplaces");
  await page.getByRole("button", { name: "Marketplace A aktualisieren" }).click();
  await expect(page.getByRole("alert")).toContainText("Aktualisierung fehlgeschlagen");
  await page.getByRole("button", { name: "Marketplace hinzufügen", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Marketplace hinzufügen" });
  await expect(panel.getByLabel("Marketplace-Quelle")).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel).not.toContainText("Aktualisierung fehlgeschlagen");
  await panel.getByLabel("Marketplace-Quelle").fill("example/plugins");
  await panel
    .getByRole("button", { name: "Marketplace hinzufügen", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("Marketplace nicht erreichbar");
  await expect(panel.getByLabel("Marketplace-Quelle")).toHaveValue("example/plugins");
  expect(calls).toBe(2);
});

test("a marketplaces link for OpenCode normalises to MCP without showing the tab", async ({
  page,
}) => {
  await setup(page, "opencode");
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route("**/accounts/fixture-opencode/plugins", async (route) => {
    await held;
    return route.fallback();
  });
  await page.goto(`${base}/extensions/fixture-opencode?tab=marketplaces`);
  await expect(page.getByRole("tab", { name: /^MCP-Server/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Marketplaces/ })).toHaveCount(0);
  await expect(page).toHaveURL(/\?tab=marketplaces$/);
  release();
  await expect(page).toHaveURL(/\/extensions\/fixture-opencode$/);
  await expect(page.getByRole("tab", { name: /^Marketplaces/ })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^MCP-Server/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.goBack();
  await expect(page).not.toHaveURL(/tab=marketplaces/);
});
