// Coding › CLIs & Erweiterungen (AC-CD-1): four tabs with today's functions, old
// addresses landing on them, and the dashboard keeping its CLI grid (D-1).
import { test, expect } from "@playwright/test";
import { fulfillDormantAssistantRequest } from "../helpers/assistant-browser-fixture.js";
import { baseURL } from "../helpers/browser.js";
import { extensionTabList } from "../helpers/extensions.js";
import { mcpFixture } from "./mcp-fixture.js";

const tabNames = ["Installation", "Accounts", "Erweiterungen", "AgentPier als MCP"];

async function fixture(page) {
  const state = {
    home: "/fixture",
    defaultCwd: "/fixture",
    defaultAccountIds: {},
    sharedCliExtensions: true,
    tools: [
      { id: "codex", name: "Codex", installed: true, version: "1.0.0" },
      { id: "claude", name: "Claude Code", installed: false },
      { id: "shell", name: "Shell", installed: true },
    ],
    utilities: [
      { id: "gh", name: "GitHub CLI", installed: true, utility: true },
      { id: "chromium", name: "Chromium", installed: true, utility: true },
    ],
    accounts: [
      { id: "local-codex", name: "Local codex", tool: "codex", kind: "local" },
      { id: "work", name: "Work codex", tool: "codex", kind: "managed" },
      { id: "local-shell", name: "Shell", tool: "shell", kind: "local" },
    ],
    sessions: [],
  };
  const reads = [];
  await mcpFixture(page);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/mcp-access")) return route.fallback();
    if (await fulfillDormantAssistantRequest(route)) return;
    const endpoint = url.pathname;
    reads.push(endpoint);
    let result = {};
    if (endpoint === "/api/state") result = state;
    else if (endpoint === "/api/accounts/usage")
      result = { accounts: {}, mcpServers: {} };
    else if (endpoint.endsWith("/auth-status")) result = { state: "authenticated" };
    else if (endpoint.endsWith("/extensions"))
      result = {
        mcp: { servers: [], note: "", path: "/fixture/.codex/config.toml" },
        skills: { items: [], note: "", installPath: "/fixture/.codex/skills" },
      };
    else if (endpoint.endsWith("/plugins"))
      result = {
        available: true,
        capabilities: { marketplaces: false, install: false },
        installed: [],
        marketplaces: [],
        catalog: [],
      };
    else if (endpoint.endsWith("/agency"))
      result = {
        revision: "a".repeat(40),
        categories: [],
        items: [],
        installed: [],
        total: 0,
        page: 1,
        hasMore: false,
      };
    return route.fulfill({ json: result });
  });
  return { state, reads };
}

const tabs = (page) => page.getByRole("tablist", { name: "CLI-Bereiche" });
async function expectTab(page, name) {
  await expect(
    tabs(page).getByRole("tab", { name: new RegExp(`^${name}`) }),
  ).toHaveAttribute("aria-selected", "true");
}

for (const mobile of [false, true])
  test(`the four tabs hold installation, accounts, extensions and MCP access (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page);
    await page.goto(baseURL + "/coding/clis");
    await expect(
      page.getByRole("heading", { name: "CLIs & Erweiterungen", level: 1 }),
    ).toBeVisible();
    await expect(tabs(page).getByRole("tab")).toHaveText(
      tabNames.map((name) => new RegExp(`^${name}`)),
    );
    await expectTab(page, "Installation");
    // Installation: the dashboard's grid with its actions.
    const panel = page.locator("#coding-tabpanel-install");
    const codex = panel.locator(".tool-card").filter({ hasText: "Codex" });
    await expect(codex.getByRole("button", { name: "Session starten" })).toBeVisible();
    await expect(codex.getByRole("button", { name: "CLI aktualisieren" })).toBeVisible();
    const claude = panel.locator(".tool-card").filter({ hasText: "Claude Code" });
    await expect(claude.getByRole("button", { name: "CLI installieren" })).toBeVisible();
    const chromium = panel.locator(".tool-card").filter({ hasText: "Chromium" });
    await chromium.getByRole("button", { name: "Entfernen" }).click();
    const confirm = page.getByRole("dialog", { name: "Chromium entfernen?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Abbrechen" }).click();
    await expect(confirm).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);

    // Accounts: native CLI accounts, list → detail.
    await tabs(page).getByRole("tab", { name: "Accounts" }).click();
    await expect(page).toHaveURL(/\/coding\/clis\?tab=accounts$/);
    await expectTab(page, "Accounts");
    const work = page.locator(".accounts-hub").getByRole("link", { name: /^Work codex/ });
    await expect(page.getByText("Native CLI-Accounts", { exact: true })).toBeVisible();
    await expect(
      page.locator(".accounts-hub").getByRole("link", { name: /^Shell/ }),
    ).toHaveCount(0);
    await work.click();
    await expect(page).toHaveURL(/\/coding\/clis\?tab=accounts&item=work$/);
    const detail = page.locator(".accounts-detail");
    await expect(detail.getByLabel("Account-Name")).toHaveValue("Work codex");
    await expect(
      detail.getByRole("button", { name: "Work codex als Standard verwenden" }),
    ).toBeVisible();
    await expect(detail.getByRole("button", { name: "Account löschen" })).toBeVisible();
    if (mobile) {
      // A phone shows the account as a subpage; back returns to the list and tabs.
      await expect(tabs(page)).toHaveCount(0);
      await page.getByRole("button", { name: "Zurück", exact: true }).click();
      await expect(page).toHaveURL(/\/coding\/clis\?tab=accounts$/);
    }

    // Erweiterungen: profiles, kinds with Unteragenten instead of Agenten.
    await tabs(page)
      .getByRole("tab", { name: /^Erweiterungen/ })
      .click();
    await expect(page).toHaveURL(/\/coding\/clis\/extensions\/local-codex$/);
    await expect(extensionTabList(page).getByRole("tab")).toHaveText([
      /^Skills/,
      /^Plugins/,
      /^Unteragenten/,
    ]);
    await expect(page.getByRole("tab", { name: /^Agenten/ })).toHaveCount(0);
    await extensionTabList(page)
      .getByRole("tab", { name: /^Unteragenten/ })
      .click();
    await expect(page).toHaveURL(
      /\/coding\/clis\/extensions\/local-codex\?tab=subagents$/,
    );
    await expect(page.getByText("Noch keine Unteragenten installiert.")).toBeVisible();

    // AgentPier als MCP: connect a CLI, connected clients.
    await tabs(page).getByRole("tab", { name: "AgentPier als MCP" }).click();
    await expect(page).toHaveURL(/\/coding\/clis\?tab=mcp$/);
    await expect(
      page.getByRole("button", { name: "Befehl kopieren: Hinzufügen", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "OpenCode", exact: true }).click();
    await expect(page).toHaveURL(/\/coding\/clis\?tab=mcp&cli=opencode$/);
    await expectTab(page, "AgentPier als MCP");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });

test("old addresses open the matching Coding tab", async ({ page }) => {
  await fixture(page);
  await page.goto(baseURL + "/accounts?section=cli&item=work");
  await expect(page).toHaveURL(/\/coding\/clis\?tab=accounts&item=work$/);
  await expectTab(page, "Accounts");
  await expect(page.locator(".accounts-detail").getByLabel("Account-Name")).toHaveValue(
    "Work codex",
  );
  await page.goto(baseURL + "/settings/mcp?cli=claude");
  await expect(page).toHaveURL(/\/coding\/clis\?tab=mcp&cli=claude$/);
  await expectTab(page, "AgentPier als MCP");
  await page.goto(baseURL + "/extensions/local-codex?tab=agents");
  await expect(page).toHaveURL(/\/coding\/clis\/extensions\/local-codex\?tab=subagents$/);
  await expect(
    extensionTabList(page).getByRole("tab", { name: /^Unteragenten/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.goto(baseURL + "/plugins/local-codex");
  await expect(page).toHaveURL(/\/coding\/clis\/extensions\/local-codex\?tab=plugins$/);
});

test("the Installation tab's GitHub CLI links to GitHub-Zugänge and installs open their dialog", async ({
  page,
}) => {
  await fixture(page);
  await page.goto(baseURL + "/coding/clis");
  const panel = page.locator("#coding-tabpanel-install");
  await panel
    .locator(".tool-card")
    .filter({ hasText: "Claude Code" })
    .getByRole("button", { name: "CLI installieren" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await panel
    .locator(".tool-card")
    .filter({ hasText: "GitHub CLI" })
    .getByRole("button", { name: "GitHub-Zugänge" })
    .click();
  await expect(page).toHaveURL(/\/connections\?section=github$/);
});

test("the start page lists every tool with its primary action", async ({ page }) => {
  await fixture(page);
  await page.goto(baseURL + "/");
  const tools = page.getByRole("region", { name: /Deine Tools/ });
  await expect(tools.locator(".start-tool")).toHaveCount(5);
  await expect(
    tools.getByRole("button", { name: "Installieren: Claude Code", exact: true }),
  ).toBeVisible();
  await tools.getByRole("button", { name: "Zugänge: GitHub CLI", exact: true }).click();
  await expect(page).toHaveURL(/\/connections\?section=github$/);
  await page.goBack();
  await page
    .getByRole("region", { name: /Deine Tools/ })
    .getByRole("link", { name: "CLIs und Erweiterungen" })
    .click();
  await expect(page).toHaveURL(/\/coding\/clis$/);
  await expect(page.locator(".tool-grid .tool-card")).toHaveCount(5);
});
