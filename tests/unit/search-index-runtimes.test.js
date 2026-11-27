// ⌘K search index, the runtimes' part (ADR 0007): a surface a runtime registers is
// found while it shows, the Hermes group of Agents › Runtime and the surfaces of an
// agent's Capabilities tab (slot agent.capabilities) per agent of that runtime. Split
// from search-index.test.js by topic.
import test from "node:test";
import assert from "node:assert/strict";
import { routePath } from "../../web/app/routes.js";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { searchEntries } from "../../web/app/search-index.js";
import { buildUserSearchIndex } from "../../web/features/users/user-search-entries.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";

const agents = [{ id: "ops", name: "Ops-Wache", capabilities: { memory: true } }];
const connections = { models: [{ id: "pc-1", name: "OpenRouter privat", words: [] }] };
const index = buildSearchIndex({ agents, connections, agentsEnabled: true });
const results = (query, entries = index) =>
  searchEntries(entries, query).flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.group })),
  );
const first = (query, entries) => results(query, entries)[0];
const pathOf = (item) => (item.target.route ? routePath(item.target.route) : null);
// ADR 0007, step 3: a runtime's surface is found while it shows.
const hermesListed = (ready, surfaces) => ({
  id: "hermes",
  name: "Hermes Agent",
  ready,
  surfaces: surfaces ?? [
    { id: "install", slot: "hub.runtime", kind: "built", shows: "always" },
  ],
});
const withRuntimes = (runtimes, agentsEnabled = true) =>
  buildSearchIndex({ agents, connections, agentsEnabled, runtimes });

test("the Hermes group of Runtime is found in both languages and lands on it", () => {
  const entries = withRuntimes([{ id: "openclaw", surfaces: [] }, hermesListed(false)]);
  const id = "page:runtime-hermes-install";
  const entry = entries.find((item) => item.id === id);
  assert.deepEqual(entry.label, { de: "Hermes Agent", en: "Hermes Agent" });
  assert.deepEqual(entry.path, {
    de: "Agenten › Laufzeit › Hermes Agent",
    en: "Agents › Runtime › Hermes Agent",
  });
  assert.equal(pathOf(entry), "/agents?tab=runtime&section=runtimes");
  for (const query of ["Hermes", "Hermes Agent", "hermes agent laufzeit"])
    assert.equal(first(query, entries).id, id, query);
  for (const query of [
    "Second runtime",
    "Zweite Laufzeit",
    "Install Hermes Agent",
    "Hermes Agent installieren",
    "Update Hermes Agent",
    "Hermes Agent aktualisieren",
  ]) {
    const hit = results(query, entries).find((item) => item.id === id);
    assert.ok(hit, query);
    assert.ok(hit.alias, `${query} is an alias`);
  }
  const ids = entries.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("a surface's search entry shows when the surface shows", () => {
  const id = "page:runtime-hermes-install";
  const has = (entries) => entries.some((item) => item.id === id);
  // An install group shows before the runtime is installed, and after.
  assert.equal(has(withRuntimes([hermesListed(false)])), true);
  assert.equal(has(withRuntimes([hermesListed(true)])), true);
  // One that shows only while the runtime is enabled follows `ready`.
  const whileEnabled = [
    { id: "install", slot: "hub.runtime", kind: "built", shows: "whileEnabled" },
  ];
  assert.equal(has(withRuntimes([hermesListed(false, whileEnabled)])), false);
  assert.equal(has(withRuntimes([hermesListed(true, whileEnabled)])), true);
  // No list (not read yet, or a server without it), no surface, or agents off.
  assert.equal(has(index), false);
  assert.equal(has(withRuntimes([])), false);
  assert.equal(has(withRuntimes([hermesListed(true, [])])), false);
  assert.equal(has(withRuntimes([hermesListed(true)], false)), false);
  assert.equal(results("Hermes", index).length, 0);
});

const hermes = (ready = true) => ({
  id: "hermes",
  name: "Hermes Agent",
  ready,
  surfaces: hermesDescriptor.surfaces,
});
const heron = {
  id: "her",
  name: "Heron",
  runtime: "hermes",
  runtimeInfo: { id: "hermes" },
};
const ops = { id: "ops", name: "Ops-Wache", capabilities: { memory: true } };
const indexOf = (agents, runtimes = [{ id: "openclaw", surfaces: [] }, hermes()]) =>
  buildSearchIndex({ agents, agentsEnabled: true, runtimes });
const id = "agent:her:hermes-mixture";

test("a Hermes agent's Mixture of Agents is found by its names in both languages", () => {
  const entries = indexOf([heron, ops]);
  const entry = entries.find((item) => item.id === id);
  assert.deepEqual(entry.label, {
    de: "Heron · Mixture of Agents",
    en: "Heron · Mixture of Agents",
  });
  assert.deepEqual(entry.path, {
    de: "Agenten › Heron › Fähigkeiten › Mixture of Agents",
    en: "Agents › Heron › Capabilities › Mixture of Agents",
  });
  assert.equal(routePath(entry.target.route), "/agents/her/settings?tab=capabilities");
  for (const query of [
    "Heron Mixture of Agents",
    "Heron MoA",
    "Heron Beratermodelle",
    "Heron advisor models",
    "Heron mehrere Modelle",
    "Heron several models",
  ])
    assert.ok(
      results(query, entries).some((item) => item.id === id),
      query,
    );
  // An agent of another runtime has none.
  assert.equal(
    entries.some((item) => item.id.startsWith("agent:ops:hermes")),
    false,
  );
  const ids = entries.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("it shows while Hermes may run agents, for agents that are not archived", () => {
  const has = (entries) => entries.some((item) => item.id === id);
  assert.equal(has(indexOf([heron], [hermes(false)])), false);
  assert.equal(has(indexOf([heron], [])), false);
  assert.equal(has(indexOf([{ ...heron, archivedAt: "2026-01-01T00:00:00Z" }])), false);
  assert.equal(
    has(
      buildSearchIndex({ agents: [heron], agentsEnabled: false, runtimes: [hermes()] }),
    ),
    false,
  );
  // Users never see the setting: their own index holds no such entry.
  assert.equal(
    buildUserSearchIndex({ agents: [heron] }).some((item) => /mixture/.test(item.id)),
    false,
  );
});

// An OpenClaw agent's "Model behaviour" (slot agent.identity): found per agent on
// its Identity tab, never for a Hermes agent or in a user's search.
test("an OpenClaw agent's model behaviour is found on its Identity tab", () => {
  const openclaw = {
    id: "openclaw",
    name: "OpenClaw",
    ready: true,
    surfaces: [
      {
        id: "modelOptions",
        slot: "agent.identity",
        kind: "built",
        shows: "whileEnabled",
      },
      {
        id: "memoryWiki",
        slot: "agent.capabilities",
        kind: "built",
        shows: "whileEnabled",
      },
    ],
  };
  const owl = { id: "owl", name: "Owl", runtimeInfo: { id: "openclaw" } };
  const entries = indexOf([owl, heron], [openclaw, hermes()]);
  const own = "agent:owl:openclaw-modelOptions";
  const entry = entries.find((item) => item.id === own);
  assert.deepEqual(entry.label, {
    de: "Owl · Modellverhalten",
    en: "Owl · Model behaviour",
  });
  assert.deepEqual(entry.path, {
    de: "Agenten › Owl › Identität › Modellverhalten",
    en: "Agents › Owl › Identity › Model behaviour",
  });
  assert.equal(routePath(entry.target.route), "/agents/owl/settings?tab=identity");
  for (const query of [
    "Owl Modellverhalten",
    "Owl Model behaviour",
    "Owl Schleifenschutz",
    "Owl Loop protection",
    "Owl Denkstufe",
    "Owl Thinking level",
    "Owl Schnellmodus",
    "Owl Fast mode",
    "Owl Denkaufwand",
    "Owl Reasoning effort",
    // Its fallback models are rows of the same group.
    "Owl Ersatzmodelle",
    "Owl Fallback models",
    "Owl Ausweichmodell",
    "Owl Failover",
    "Owl Reservemodell",
    "Owl Backup model",
  ])
    assert.ok(
      results(query, entries).some((item) => item.id === own),
      query,
    );
  // The wiki's entry still opens the Capabilities tab.
  assert.equal(
    routePath(
      entries.find((item) => item.id === "agent:owl:openclaw-memoryWiki").target.route,
    ),
    "/agents/owl/settings?tab=capabilities",
  );
  // A Hermes agent has no such group, an archived agent no entry at all.
  assert.equal(
    entries.some((item) => item.id.startsWith("agent:her:openclaw")),
    false,
  );
  const archived = indexOf([{ ...owl, archivedAt: "2026-01-01T00:00:00Z" }], [openclaw]);
  assert.equal(
    archived.some((item) => item.id === own),
    false,
  );
  // A temporary member has the Identity tab and shows that it follows its lead.
  const member = { ...owl, id: "m1", teamMemberId: "tm-1", lifetime: "task" };
  assert.ok(
    indexOf([member], [openclaw]).some(
      (item) => item.id === "agent:m1:openclaw-modelOptions",
    ),
  );
  const ids = entries.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  // The users' own search never lists the owner's settings.
  const users = buildUserSearchIndex({ agents: [owl] });
  for (const query of [
    "Denkstufe",
    "Thinking level",
    "Fast mode",
    "Schnellmodus",
    "Loop protection",
    "Schleifenschutz",
    "Fallback models",
    "Ersatzmodelle",
  ])
    assert.equal(results(query, users).length, 0, query);
});
