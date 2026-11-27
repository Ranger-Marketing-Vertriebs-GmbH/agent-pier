// What an agent's sessions used (docs/agents.md "Usage"): the chat's usage in its
// header, with a sheet of tokens, cost and context that follows the live topic
// `agent.chat-usage`, and the Usage group on the agent's Overview (`agent.usage`).
// A model without a price shows tokens only; a runtime without a usage record shows
// no figures and says why.
import { test, expect } from "../helpers/browser-test.js";
import { baseURL } from "../helpers/browser.js";
import { chatAssistant, chatFixture } from "../helpers/assistant-chat-fixture.js";
import { settingsPath } from "../helpers/agent-settings-page.js";

const openClaw = {
  id: "openclaw",
  name: "OpenClaw",
  version: "2026.11.6",
  capabilities: { usage: { available: true } },
};
const hermes = {
  id: "hermes",
  name: "Hermes",
  version: "1.0",
  capabilities: { usage: { available: false, reason: "usageUnsupported" } },
};
const tokens = (input, output, cacheRead) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  total: input + output + cacheRead,
});
const usd = (amount, partial = false) => ({ amount, currency: "USD", partial });
const chatUsage = (patch = {}) => ({
  tokens: tokens(1000, 300, 200),
  cost: usd(0.0045),
  pending: false,
  context: { used: 1200, limit: 32768 },
  updatedAt: "2026-11-27T12:00:00.000Z",
  ...patch,
});
const period = (id, days, total, cost) => ({
  id,
  days,
  from: "2026-11-27",
  to: "2026-11-27",
  tokens: tokens(total - 500, 300, 200),
  cost,
  pending: false,
});
const agentUsage = (cost = usd(0.42)) => ({
  periods: [
    period("today", 1, 1500, cost),
    period("week", 7, 84000, cost && usd(3.1, true)),
    period("month", 30, 2400000, cost && usd(41.07, true)),
  ],
  daily: Array.from({ length: 30 }, (_, index) => ({
    date: `2026-${index < 3 ? "10" : "11"}-${String(index < 3 ? 29 + index : index - 2).padStart(2, "0")}`,
    tokens: index * 1000,
  })),
  pending: false,
  updatedAt: "2026-11-27T12:00:00.000Z",
});

// The chat of `assistant`, whose usage route answers `state.usage` (404 without).
async function chat(page, assistant = {}) {
  const state = await chatFixture(page, {
    assistants: [chatAssistant({ runtimeInfo: openClaw, ...assistant })],
    conversations: [{ id: "dinner", assistantId: "home", title: "Dinner plans" }],
  });
  state.usage = chatUsage();
  state.usageReads = 0;
  await page.route("**/api/assistants/home/pinboard", (route) =>
    route.fulfill({ json: { fresh: 0, lists: [] } }),
  );
  await page.route("**/api/assistant-conversations/dinner/usage", (route) => {
    state.usageReads++;
    return state.usage
      ? route.fulfill({ json: state.usage })
      : route.fulfill({ status: 404, json: { error: "Not found." } });
  });
  await page.route("**/api/assistants/home/usage", (route) =>
    state.agentUsage
      ? route.fulfill({ json: state.agentUsage })
      : route.fulfill({ status: 404, json: { error: "Not found." } }),
  );
  return state;
}

const button = (page) => page.getByRole("button", { name: /^Usage of this chat:/ });
const sheet = (page) => page.getByRole("dialog", { name: "Usage of this chat" });
const row = (scope, label) =>
  scope.locator(".list-row").filter({
    has: scope.page().locator(".list-row-label", { hasText: new RegExp(`^${label}$`) }),
  });

for (const [name, use] of [
  ["desktop", { viewport: { width: 1280, height: 900 } }],
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
])
  test.describe(name, () => {
    test.use(use);

    test("a chat shows its tokens, cost and context, and follows a finished turn", async ({
      page,
      liveStub,
    }) => {
      const state = await chat(page);
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await expect(button(page)).toHaveText("1.5K");
      await expect(button(page)).toHaveAccessibleName("Usage of this chat: 1.5K tokens");
      await button(page).click();
      const dialog = sheet(page);
      await expect(dialog).toBeVisible();
      for (const [label, value] of [
        ["Input", "1K"],
        ["Output", "300"],
        ["Read from cache", "200"],
        ["Total", "1.5K"],
        ["Cost", "$0.0045"],
      ])
        await expect(row(dialog, label).locator(".list-row-value")).toHaveText(value);
      await expect(
        row(dialog, "Context at the last model call").locator(".list-row-sub"),
      ).toHaveText("1.2K of 32.8K tokens (4 %)");
      // Nothing was written to the cache: no row for it.
      await expect(row(dialog, "Written to cache")).toHaveCount(0);
      // The sheet fits the screen without scrolling sideways.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);

      // A turn finished: the server signals the topic, the open sheet shows it.
      state.usage = chatUsage({
        tokens: tokens(2400, 700, 900),
        cost: usd(1.5, true),
        context: { used: 3300, limit: 32768 },
      });
      await liveStub.reread("agent.chat-usage:dinner");
      await expect(row(dialog, "Total").locator(".list-row-value")).toHaveText("4K");
      await expect(row(dialog, "Cost").locator(".list-row-value")).toHaveText(
        "at least $1.50",
      );
      await expect(row(dialog, "Cost")).toContainText(
        "Some model calls have no price, so the cost is at least this amount.",
      );
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(button(page)).toHaveText("4K");
    });

    test("a model without a price shows tokens and no cost", async ({ page }) => {
      const state = await chat(page);
      state.usage = chatUsage({ cost: null, pending: true });
      await page.goto(baseURL + "/agents/home/chats/dinner");
      await button(page).click();
      const dialog = sheet(page);
      await expect(row(dialog, "Total").locator(".list-row-value")).toHaveText("1.5K");
      await expect(row(dialog, "Cost").locator(".list-row-value")).toHaveText("No price");
      await expect(row(dialog, "Cost")).toContainText(
        "This chat's model has no price per token",
      );
      await expect(dialog).not.toContainText("$");
      // Figures OpenClaw still computes say so.
      await expect(dialog.getByRole("status")).toHaveText("Still being calculated …");
    });
  });

test("a chat that used nothing, and a runtime without a usage record, show no usage", async ({
  page,
}) => {
  const state = await chat(page);
  state.usage = chatUsage({ tokens: tokens(0, 0, 0), cost: null, context: null });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.locator(".assistant-header")).toBeVisible();
  await expect.poll(() => state.usageReads).toBeGreaterThan(0);
  await expect(button(page)).toHaveCount(0);
});

test("a Hermes agent's chat asks for no usage; its Overview says why", async ({
  page,
}) => {
  const state = await chat(page, { runtime: "hermes", runtimeInfo: hermes });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("We can plan dinner together.")).toBeVisible();
  await expect(button(page)).toHaveCount(0);
  expect(state.usageReads).toBe(0);
  await page.goto(baseURL + settingsPath());
  const group = page.locator("#agent-usage");
  await expect(group.getByRole("heading", { name: "Usage" })).toBeVisible();
  await expect(group.getByRole("note")).toHaveText("Hermes records no token usage.");
  await expect(row(group, "Today").locator(".list-row-value")).toHaveText("—");
});

test("the Overview shows today, 7 and 30 days with the tokens per day", async ({
  page,
  liveStub,
}) => {
  const state = await chat(page);
  state.agentUsage = agentUsage();
  await page.goto(baseURL + settingsPath());
  const group = page.locator("#agent-usage");
  await expect(group.getByRole("heading", { name: "Usage" })).toBeVisible();
  await expect(row(group, "Today").locator(".list-row-value")).toHaveText("$0.42");
  await expect(row(group, "Today").locator(".list-row-sub")).toHaveText(
    "1.5K tokens · 1K in · 300 out · 200 from cache",
  );
  await expect(row(group, "Last 7 days").locator(".list-row-value")).toHaveText(
    "at least $3.10",
  );
  await expect(row(group, "Last 30 days").locator(".list-row-value")).toHaveText(
    "at least $41.07",
  );
  await expect(row(group, "Last 30 days").locator(".list-row-sub")).toContainText(
    "2.4M tokens",
  );
  // The tokens per day, as bars with a table for screen readers.
  await expect(group.locator(".value-chart-bar")).toHaveCount(30);
  await expect(
    group.getByRole("table", { name: "Tokens per day over the last 30 days" }),
  ).toBeAttached();
  // The hint says where a cost shows.
  await group.getByRole("button", { name: "Show hint" }).click();
  await expect(group).toContainText("A ChatGPT account is a subscription");

  // A ChatGPT account's agent: tokens, never a cost.
  state.agentUsage = agentUsage(null);
  await liveStub.reread("agent.usage:home");
  for (const label of ["Today", "Last 7 days", "Last 30 days"])
    await expect(row(group, label).locator(".list-row-value")).toHaveText("No price");
  await expect(group.locator(".list-card")).not.toContainText("$");
});

test("an agent whose runtime view states no usage is asked nothing", async ({ page }) => {
  // As every fixture agent without a runtime view: no request the fixtures must know.
  const requests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/usage")) requests.push(request.url());
  });
  await chat(page, { runtimeInfo: undefined });
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(page.getByText("We can plan dinner together.")).toBeVisible();
  await expect(button(page)).toHaveCount(0);
  await page.goto(baseURL + settingsPath());
  const group = page.locator("#agent-usage");
  await expect(row(group, "Today").locator(".list-row-value")).toHaveText("—");
  expect(requests).toEqual([]);
});

for (const status of [404, 500])
  test(`a usage read that fails with ${status} leaves the chat and the Overview quiet`, async ({
    page,
  }) => {
    const state = await chat(page);
    const reads = { chat: 0, agent: 0 };
    await page.route("**/api/assistant-conversations/dinner/usage", (route) => {
      reads.chat++;
      return route.fulfill({ status, json: { error: "Not available." } });
    });
    await page.route("**/api/assistants/home/usage", (route) => {
      reads.agent++;
      return route.fulfill({ status, json: { error: "Not available." } });
    });
    await page.goto(baseURL + "/agents/home/chats/dinner");
    await expect(page.getByText("We can plan dinner together.")).toBeVisible();
    await expect.poll(() => reads.chat).toBeGreaterThan(0);
    // No figure, no error, and the chat still takes a message.
    await expect(button(page)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("textbox").first().fill("Still there?");
    await page.keyboard.press("Enter");
    await expect.poll(() => state.posted.length).toBe(1);
    await page.goto(baseURL + settingsPath());
    const group = page.locator("#agent-usage");
    await expect(group.getByRole("status")).toHaveText(
      "The usage cannot be read right now.",
    );
    await expect(row(group, "Today").locator(".list-row-value")).toHaveText("—");
    await expect(page.getByRole("alert")).toHaveCount(0);
    // No retry storm: the reads stay a handful while the pages sit open.
    await page.waitForTimeout(1500);
    expect(reads.chat).toBeLessThanOrEqual(3);
    expect(reads.agent).toBeLessThanOrEqual(3);
  });

test("⌘K opens the usage of the chat on screen", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", {
      get: () => "Linux x86_64",
      configurable: true,
    });
    Object.defineProperty(Navigator.prototype, "userAgentData", {
      get: () => ({ platform: "Linux", brands: [], mobile: false }),
      configurable: true,
    });
  });
  await chat(page);
  const empty = {
    "/api/repositories": { repositories: [] },
    "/api/memory/projects": { projects: [] },
    "/api/pipelines": { pipelines: [] },
    "/api/pipeline-runs": { runs: [], total: 0, page: 1, pageSize: 20 },
    "/api/inbox": { instance: "fixture", revision: 1, items: [], counts: { all: 0 } },
  };
  await page.route(
    (url) => Object.hasOwn(empty, url.pathname),
    (route) => route.fulfill({ json: empty[new URL(route.request().url()).pathname] }),
  );
  await page.goto(baseURL + "/agents/home/chats/dinner");
  await expect(button(page)).toBeVisible();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog", { name: "Search" });
  await search.getByRole("combobox").fill("Usage of this chat");
  await search
    .getByRole("option", { name: "Usage of this chat Agents", exact: true })
    .click();
  await expect(sheet(page)).toBeVisible();
});
