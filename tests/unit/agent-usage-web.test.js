import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  contextText,
  costText,
  dailyPoints,
  formatCost,
  hasUsage,
  tokenRows,
  tokensText,
} from "../../web/features/assistants/usage/usage-presentation.js";
import { capabilityOf, unavailableText } from "../../web/components/capability-gate.js";
import { topicInfo } from "../../web/lib/live/live-topics.js";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { searchEntries } from "../../web/app/search-index.js";
import { routePath } from "../../web/app/routes.js";

// An agent's usage in the web app (docs/agents.md "Usage"): how tokens, cost and
// context read, where the figures come from, and how ⌘K finds them.

const tokens = {
  input: 8000,
  output: 1200,
  cacheRead: 3200,
  cacheWrite: 0,
  total: 12400,
};
const usd = (amount, partial = false) => ({ amount, currency: "USD", partial });

test("a cost is money in its currency; an unknown one is never an amount", (t) => {
  t.after(() => setLanguage("de"));
  setLanguage("en");
  assert.equal(formatCost(usd(1.5)), "$1.50");
  // Below a cent it shows to a hundredth of a cent.
  assert.equal(formatCost(usd(0.0045)), "$0.0045");
  assert.equal(formatCost(usd(0)), "$0.00");
  for (const cost of [
    null,
    undefined,
    {},
    usd(-1),
    usd(NaN),
    { amount: 1, currency: "$" },
  ])
    assert.equal(formatCost(cost), null);
  assert.equal(costText({ tokens, cost: usd(1.5) }), "$1.50");
  assert.equal(costText({ tokens, cost: usd(1.5, true) }), "at least $1.50");
  // Usage without a price says so; no usage shows no cost at all.
  assert.equal(costText({ tokens, cost: null }), "No price");
  assert.equal(costText({ tokens: { ...tokens, total: 0 }, cost: null }), "");
  assert.equal(costText(undefined), "");
  setLanguage("de");
  assert.equal(costText({ tokens, cost: null }), "Kein Preis");
  assert.match(costText({ tokens, cost: usd(1.5, true) }), /^mindestens 1,50\s\$$/);
});

test("tokens read compactly with their parts, the cache only when used", (t) => {
  t.after(() => setLanguage("de"));
  setLanguage("en");
  assert.equal(hasUsage({ tokens }), true);
  assert.equal(hasUsage({ tokens: { total: 0 } }), false);
  assert.equal(hasUsage(null), false);
  assert.equal(
    tokensText({ tokens }),
    "12.4K tokens · 8K in · 1.2K out · 3.2K from cache",
  );
  assert.equal(
    tokensText({ tokens: { ...tokens, cacheRead: 0, total: 9200 } }),
    "9.2K tokens · 8K in · 1.2K out",
  );
  assert.equal(tokensText({ tokens: { ...tokens, total: 0 } }), "No usage");
  assert.deepEqual(tokenRows({ tokens }), [
    { id: "input", value: "8K" },
    { id: "output", value: "1.2K" },
    { id: "cacheRead", value: "3.2K" },
    { id: "total", value: "12.4K" },
  ]);
  assert.deepEqual(
    tokenRows({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }).map((row) => row.id),
    ["input", "output", "total"],
  );
});

test("the context names its fill of the model's window when that is known", (t) => {
  t.after(() => setLanguage("de"));
  setLanguage("en");
  assert.equal(contextText({ used: 12000, limit: 200000 }), "12K of 200K tokens (6 %)");
  // A size over the window never reads as more than all of it.
  assert.equal(
    contextText({ used: 300000, limit: 200000 }),
    "300K of 200K tokens (100 %)",
  );
  assert.equal(contextText({ used: 12000, limit: null }), "12K tokens");
  assert.equal(contextText(null), null);
  assert.equal(contextText({ used: 0, limit: 200000 }), null);
});

test("the chart's bars are the days in order", () => {
  const day = (date) => date.slice(5);
  assert.deepEqual(
    dailyPoints(
      [
        { date: "2026-11-26", tokens: 0 },
        { date: "2026-11-27", tokens: 1500 },
        { date: 7, tokens: 1 },
        { date: "2026-11-28", tokens: -1 },
      ],
      day,
    ),
    [
      { label: "11-26", value: 0 },
      { label: "11-27", value: 1500 },
    ],
  );
  assert.deepEqual(dailyPoints(undefined, day), []);
});

test("a runtime without a usage record says so in both languages", (t) => {
  t.after(() => setLanguage("de"));
  const hermes = {
    name: "Hermes",
    capabilities: { usage: { available: false, reason: "usageUnsupported" } },
  };
  assert.equal(capabilityOf(hermes, "usage").available, false);
  assert.equal(
    capabilityOf({ name: "OpenClaw", capabilities: {} }, "usage").available,
    true,
  );
  setLanguage("en");
  assert.equal(unavailableText(hermes, "usage"), "Hermes records no token usage.");
  setLanguage("de");
  assert.equal(
    unavailableText(hermes, "usage"),
    "Hermes zeichnet keinen Token-Verbrauch auf.",
  );
});

test("the usage topics read their routes; the fallback polls slowly", () => {
  for (const [name, path] of [
    ["agent.usage", "/assistants/a%2Fb/usage"],
    ["agent.chat-usage", "/assistant-conversations/a%2Fb/usage"],
  ]) {
    const info = topicInfo(`${name}:a/b`);
    assert.deepEqual(
      [info.mode, info.path(info.param), info.interval, info.sampled],
      ["state", path, 60000, false],
      name,
    );
    // Each one is an agent's or a chat's: the parameter is required.
    assert.equal(topicInfo(name), null, name);
  }
});

test("⌘K finds an agent's usage and the chat's own, in both languages", () => {
  const agents = [
    { id: "ops", name: "Ops-Wache" },
    { id: "old", name: "Alt", archivedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const index = buildSearchIndex({
    agents,
    agentsEnabled: true,
    offered: ["chat-usage"],
  });
  const hits = (query) =>
    searchEntries(index, query).flatMap((group) => group.items.map((item) => item.id));
  const group = index.find((entry) => entry.id === "agent:ops:group:usage");
  assert.equal(group.label.en, "Ops-Wache · Usage");
  assert.equal(group.label.de, "Ops-Wache · Verbrauch");
  assert.equal(group.path.en, "Agents › Ops-Wache › Overview › Usage");
  assert.equal(routePath(group.target.route), "/agents/ops/settings");
  for (const query of [
    "Ops usage",
    "Ops Verbrauch",
    "Ops tokens",
    "Ops cost",
    "Ops Kosten",
  ])
    assert.ok(hits(query).includes("agent:ops:group:usage"), query);
  assert.equal(
    index.some((entry) => entry.id === "agent:old:group:usage"),
    false,
  );
  // The chat's usage sheet is the chat's own action: offered only while it shows.
  for (const query of [
    "Usage of this chat",
    "Verbrauch dieses Chats",
    "Tokens of this chat",
    "Tokens dieses Chats",
  ])
    assert.ok(hits(query).includes("action:chat-usage"), query);
  const without = buildSearchIndex({ agents, agentsEnabled: true });
  assert.equal(
    without.some((entry) => entry.id === "action:chat-usage"),
    false,
  );
});
