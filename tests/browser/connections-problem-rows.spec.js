import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { fixture } from "./providers-fixture.js";
import { hostId, mcpServer, syntheticHosts } from "./connections-fixture.js";

// Zugänge: every category's list marks exactly the entries the highlighted number of
// the categories counts (GET /connections/problems), with a text label, on desktop and
// phones; a row without a value keeps its chevron at the row's end.

test.use({ locale: "en-GB" });

const entry = (id, reasons) => ({ id, reasons });
const category = (total, problems = [], warnings = []) => ({
  total,
  problems,
  warnings,
  unknown: [],
});
const credential = (id, name, tokenCheck = null) => ({
  id,
  name,
  host: "https://github.com",
  hasSecret: true,
  agentDefault: false,
  createdAt: "2026-10-01T00:00:00Z",
  tokenCheck,
});
const mailAccount = (id, name, extra = {}) => ({
  id,
  name,
  address: `${id}@example.com`,
  imap: { host: "imap.example.com", port: 993, security: "tls", username: id },
  smtp: { host: "smtp.example.com", port: 465, security: "tls", username: id },
  allowPlaintext: false,
  saveSent: true,
  lastTest: { at: "2026-10-20T10:00:00.000Z", imap: "ok", smtp: "ok" },
  hasPassword: true,
  ...extra,
});

async function setup(page) {
  const controls = await fixture(page);
  controls.state.providerConnections = [
    { id: "c1", name: "Shared router", providerId: "openrouter", hasSecret: true },
    {
      id: "c2",
      name: "Broken router",
      providerId: "openrouter",
      hasSecret: false,
      launchable: false,
    },
  ];
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  await page.route(/\/api\/assistant/, async (route) => {
    if (await fulfillEnabledAssistantFeature(route)) return;
    const path = new URL(route.request().url()).pathname;
    const json =
      path === "/api/assistant-model-accounts"
        ? {
            accounts: [
              { id: "openclaw:ok", name: "ok@example.com", status: "ok" },
              { id: "openclaw:old", name: "old@example.com", status: "expired" },
            ],
          }
        : path === "/api/assistant-runtime"
          ? { availability: "ready", sync: "current" }
          : path === "/api/assistant-web-search"
            ? { revision: 0, provider: "brave", hasBraveKey: false, ready: false }
            : null;
    if (!json) return route.fallback();
    await route.fulfill({ json });
  });
  await page.route("**/api/mcp-servers", (route) =>
    route.fulfill({
      json: [
        mcpServer("docs", "Docs"),
        mcpServer("mail", "Mail", { auth: "oauth", oauthStatus: "login-required" }),
      ],
    }),
  );
  const hosts = syntheticHosts(4);
  await page.route("**/api/ssh-accesses", (route) =>
    route.fulfill({ json: { accesses: hosts } }),
  );
  await page.route("**/api/secrets", (route) =>
    route.fulfill({
      json: {
        secrets: [
          { id: "s1", name: "DEPLOY_TOKEN", projectId: null },
          { id: "s2", name: "MAIL_KEY", projectId: null },
        ],
      },
    }),
  );
  await page.route("**/api/repositories", (route) =>
    route.fulfill({
      json: {
        repositories: [],
        credentials: [
          credential("g1", "Work"),
          credential("g2", "Old", { state: "expired", scopes: null }),
        ],
      },
    }),
  );
  await page.route("**/api/mail/accounts", (route) =>
    route.fulfill({
      json: {
        presets: {},
        accounts: [
          mailAccount("support", "Support"),
          mailAccount("broken", "Broken box", {
            lastTest: {
              at: "2026-10-20T10:00:00.000Z",
              imap: "ok",
              smtp: "MAIL_AUTH_FAILED",
            },
          }),
          mailAccount("plain", "Plain box", {
            allowPlaintext: true,
            imap: {
              host: "imap.example.com",
              port: 143,
              security: "none",
              username: "p",
            },
          }),
        ],
      },
    }),
  );
  await page.route("**/api/connections/problems", (route) =>
    route.fulfill({
      json: {
        agentsEnabled: true,
        // A native CLI account's check is no row of Zugänge and never counted.
        models: category(4, [
          entry("c2", ["keyMissing"]),
          entry("openclaw:old", ["signInExpired"]),
          entry("cli-account", []),
        ]),
        services: category(1, [], [entry("webSearch", ["notConfigured"])]),
        mcp: category(2, [entry("mail", ["loginRequired"])]),
        ssh: category(4, [entry(hostId(3), ["testFailed"])]),
        secrets: category(2, [entry("s1", ["unreadable"])]),
        github: category(2, [entry("g2", ["tokenExpired"])]),
        mail: category(
          3,
          [entry("broken", ["testFailed"])],
          [entry("plain", ["plaintext"])],
        ),
      },
    }),
  );
}

const sections = [
  ["models", "Model access", ["Broken router", "old@example.com"]],
  ["services", "Services for agents", ["Web search"]],
  ["mcp-servers", "MCP servers", ["Mail"]],
  ["ssh", "SSH/SFTP accesses", ["server-003"]],
  ["secrets", "Secrets", ["DEPLOY_TOKEN"]],
  ["github", "GitHub connections", ["Old"]],
  ["mail", "Email accounts", ["Broken box", "Plain box"]],
];
// List rows whose link names the entry and the mark, with the sub line in warning tone.
const rowLists = new Set(["models", "services", "mail"]);
// Long lists mark a row by its status cell; the other lists carry the warning chip.
const longLists = new Set(["mcp-servers", "ssh"]);
const markedRows = (page, section) =>
  longLists.has(section)
    ? page.locator(".long-list-row.has-problem")
    : page.locator(".connections-main .connections-problem");

async function badges(page) {
  const nav = page.getByRole("navigation", { name: "Categories" });
  const counts = {};
  for (const [section, label] of sections) {
    const link = nav.getByRole("link", {
      name: new RegExp(`^${label.replace("/", "\\/")}`),
    });
    await expect(link).toBeVisible();
    const flag = link.locator(".connections-flag");
    counts[section] = (await flag.count()) ? Number(await flag.textContent()) : 0;
  }
  return counts;
}

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 1000 }],
  ["phone", { width: 390, height: 844 }],
]) {
  test(`marked rows equal the highlighted numbers in every category (${name})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await page.goto(baseURL + "/connections");
    await expect(page.locator(".connections-flag")).toHaveCount(sections.length);
    const counts = await badges(page);
    for (const [section, , names] of sections) {
      await page.goto(baseURL + `/connections?section=${section}`);
      const rows = markedRows(page, section);
      await expect(rows.first()).toBeVisible();
      await expect(rows).toHaveCount(counts[section]);
      expect(counts[section]).toBe(names.length);
      for (const [index, entryName] of names.entries())
        await expect(rows.nth(index)).toContainText(
          longLists.has(section) ? entryName : "Problem",
        );
      if (longLists.has(section)) {
        // The status cell names the state for screen readers.
        const open = rows.first().getByRole("button", { name: names[0], exact: true });
        await expect(open).toHaveAccessibleDescription(/Test failed|Sign-in expired/);
      } else if (rowLists.has(section)) {
        // The row's link names the entry and the mark; its sub line takes the warning tone.
        for (const entryName of names)
          await expect(
            page.getByRole("link", { name: new RegExp(`^${entryName}\\s*Problem`) }),
          ).toBeVisible();
        const sub = page.locator(".list-row.has-problem .list-row-sub").first();
        const healthy = page.locator(".list-row:not(.has-problem) .list-row-sub").first();
        expect(await sub.evaluate((node) => getComputedStyle(node).color)).not.toBe(
          await healthy.evaluate((node) => getComputedStyle(node).color),
        );
      } else {
        await expect(rows.first()).toBeVisible();
        const owner =
          section === "secrets"
            ? page.locator(".secrets-item")
            : page.locator(".github-access-name");
        await expect(owner.filter({ hasText: names[0] })).toContainText("Problem");
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  });
}

test("a row without a value keeps its chevron at the row's end on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto(baseURL + "/connections?section=models");
  const row = page.locator(".list-row", { hasText: "ChatGPT for agents" });
  await expect(row).toBeVisible();
  const rowBox = await row.boundingBox();
  const chevron = await row.locator(".list-row-chevron").boundingBox();
  // The row's end padding is 12px.
  expect(rowBox.x + rowBox.width - (chevron.x + chevron.width)).toBeLessThanOrEqual(14);
});
