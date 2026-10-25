import { test, expect } from "@playwright/test";
import { baseURL } from "../helpers/browser.js";
import { fulfillEnabledAssistantFeature } from "../helpers/assistant-browser-fixture.js";
import { accountRow } from "../helpers/accounts-browser.js";
import { fixture } from "./providers-fixture.js";

test.use({ locale: "en-GB" });

const connection = {
  id: "c1",
  name: "Shared router",
  providerId: "openrouter",
  hasSecret: true,
  launchable: true,
  tools: ["codex", "claude", "opencode"],
};
const used = (agents) => ({ agents, sessions: 0, pipelineProfiles: [], clis: [] });

async function setup(page, { agents = true, usage = "ok" } = {}) {
  const controls = await fixture(page);
  controls.state.providerConnections = [connection];
  controls.state.accounts = [
    { id: "managed-codex", name: "Work Codex", tool: "codex", kind: "managed" },
  ];
  controls.usage = {
    agentsEnabled: agents,
    connections: {
      c1: used([{ id: "home", name: "Home", kind: "agent", via: "model" }]),
    },
    chatgpt: {},
    mcpServers: {},
    webSearch: agents ? used([]) : null,
    speech: agents ? used([]) : null,
    cliAccounts: {},
  };
  await page.addInitScript(() => localStorage.setItem("agentpier-language", "en"));
  if (agents)
    await page.route("**/api/assistant-feature", (route) =>
      fulfillEnabledAssistantFeature(route),
    );
  if (usage === "fail")
    await page.route("**/api/accounts/usage", (route) =>
      route.fulfill({ status: 500, json: { error: "usage down" } }),
    );
  return controls;
}

test("the hub lists the four groups with usage", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  for (const name of [
    "Model access",
    "Services for agents",
    "MCP servers",
    "Native CLI accounts",
  ])
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(accountRow(page, "Shared router")).toContainText("1 agent");
  await expect(accountRow(page, "Shared router")).toContainText("OpenRouter");
  await expect(accountRow(page, "Speech recognition")).toBeVisible();
  await expect(accountRow(page, "Web search")).toContainText("DuckDuckGo");
  await expect(accountRow(page, "ChatGPT for agents")).toBeVisible();
  await expect(accountRow(page, "Work Codex")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add provider connection", exact: true }),
  ).toBeVisible();
});

test("usage stays unknown when the endpoint fails", async ({ page }) => {
  await setup(page, { usage: "fail" });
  await page.goto(baseURL + "/accounts");
  await expect(accountRow(page, "Shared router")).toContainText("—");
  await expect(accountRow(page, "Shared router")).not.toContainText("0");
});

test("without agents the services group is hidden and no agent request is made", async ({
  page,
}) => {
  const controls = await setup(page, { agents: false });
  await page.goto(baseURL + "/accounts");
  await expect(
    page.getByRole("heading", { name: "MCP servers", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Services for agents" })).toHaveCount(0);
  await expect(accountRow(page, "ChatGPT for agents")).toHaveCount(0);
  expect(
    controls.calls
      .map((call) => call.path)
      .filter(
        (path) => path.startsWith("/api/assistant") && path !== "/api/assistant-feature",
      ),
  ).toEqual([]);
});

test("the header note is a disclosure with the stored-locally text", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts");
  const button = page.getByRole("button", { name: "Show note about accounts" });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const panel = page.locator(`#${await button.getAttribute("aria-controls")}`);
  await expect(panel).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toContainText("Everything stays on your computer.");
  await expect(panel).toContainText("Separate profiles have their own sign-in");
  await expect(
    page.locator(".settings-shell-actions").getByText("Stored locally"),
  ).toBeVisible();
});

test("an unknown item returns to its group once", async ({ page }) => {
  await setup(page);
  await page.goto(baseURL + "/accounts?section=models&item=gone");
  await expect(page).toHaveURL(`${baseURL}/connections?section=models`);
  await expect(accountRow(page, "Shared router")).toBeVisible();
});

test("phones show the hub with the sidebar button and the intro", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto(baseURL + "/accounts");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expect(page.locator(".mobile-header")).toBeHidden();
  await expect(page.locator(".accounts-intro")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});

test("the extensions link lands on the MCP group", async ({ page }) => {
  await setup(page, { agents: false });
  await page.goto(baseURL + "/accounts?section=mcp-servers");
  await expect(page.getByRole("region", { name: "MCP servers" })).toBeInViewport();
  await expect(accountRow(page, "Found in the CLIs")).toBeVisible();
});

for (const [availability, expected] of [
  ["disabled", "Service offline"],
  ["ready", "Connected"],
]) {
  test(`ChatGPT rows show ${expected} while the runtime is ${availability}`, async ({
    page,
  }) => {
    await setup(page);
    await page.route("**/api/assistant-model-accounts", (route) =>
      route.fulfill({
        json: {
          accounts: [{ id: "gpt1", name: "Team ChatGPT", status: "ok" }],
        },
      }),
    );
    await page.route("**/api/assistant-runtime", (route) =>
      route.fulfill({ json: { availability, sync: "stale" } }),
    );
    await page.goto(baseURL + "/accounts");
    await expect(accountRow(page, "Team ChatGPT")).toContainText(expected);
  });
}
