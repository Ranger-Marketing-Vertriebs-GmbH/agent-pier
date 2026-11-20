// AGENTPIER-434: the agent's own browser is reachable while its capability is on,
// browser running or not: the chat header, ⌘K ("<Agent>'s browser") and the agent's
// take-over link in its chat.
import test from "node:test";
import assert from "node:assert/strict";
import { routePath } from "../../web/app/routes.js";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { searchEntries } from "../../web/app/search-index.js";
import {
  browserOffered,
  browserRoute,
  takeoverHref,
} from "../../web/features/assistants/browser/browser-entry.js";
import { takeoverUrl } from "../../web/features/assistants/browser/takeover-link.js";

const ops = { id: "ops", name: "Ops-Wache", capabilities: { browser: true } };

test("the browser is offered while the capability is on, running or not", () => {
  assert.equal(browserOffered(ops), true);
  assert.equal(browserOffered({ ...ops, browserRunning: true }), true);
  assert.equal(browserOffered({ ...ops, capabilities: { browser: false } }), false);
  assert.equal(browserOffered({ ...ops, capabilities: {} }), false);
  assert.equal(browserOffered({ ...ops, archivedAt: "2026-01-01T00:00:00Z" }), false);
  // A task-bound member has no browser profile of its own; a permanent one has.
  assert.equal(browserOffered({ ...ops, teamMemberId: "m", lifetime: "task" }), false);
  assert.equal(
    browserOffered({ ...ops, teamMemberId: "m", lifetime: "permanent" }),
    true,
  );
  // A user's own agent is hers.
  assert.equal(browserOffered({ ...ops, userAccess: { mode: "own" } }), false);
  assert.equal(browserOffered(null), false);
});

test("the browser route opens the page, with take-over on request", () => {
  assert.equal(routePath(browserRoute("ops")), "/agents/ops/browser");
  assert.equal(
    routePath(browserRoute("ops", { takeover: true })),
    "/agents/ops/browser?takeover=1",
  );
});

test("⌘K finds an agent's browser in both languages, only while it is on", () => {
  const index = buildSearchIndex({
    agents: [ops, { id: "off", name: "Ohne", capabilities: { browser: false } }],
    agentsEnabled: true,
  });
  const hits = (query) =>
    searchEntries(index, query).flatMap((group) => group.items.map((item) => item.id));
  for (const query of ["Browser von Ops-Wache", "Ops-Wache's browser", "ops browser"])
    assert.ok(hits(query).includes("agent:ops:browser"), query);
  const entry = index.find((item) => item.id === "agent:ops:browser");
  assert.equal(entry.label.de, "Browser von Ops-Wache");
  assert.equal(entry.label.en, "Ops-Wache's browser");
  assert.equal(routePath(entry.target.route), "/agents/ops/browser");
  // Its icon is the agent's initial in either language (AGENTPIER-440 U9).
  assert.equal(entry.mark, "Ops-Wache");
  assert.ok(!index.some((item) => item.id === "agent:off:browser"));
  // Agents switched off: no agent entries at all.
  const off = buildSearchIndex({ agents: [ops], agentsEnabled: false });
  assert.ok(!off.some((item) => item.id === "agent:ops:browser"));
});

test("only the take-over link an agent writes survives the chat's URL check", () => {
  assert.equal(takeoverUrl(takeoverHref), takeoverHref);
  assert.equal(takeoverUrl("https://example.com/"), "https://example.com/");
  assert.equal(takeoverUrl("javascript:alert(1)"), "");
  assert.equal(takeoverUrl("agentpier:other"), "");
});
