import test from "node:test";
import assert from "node:assert/strict";
import { routePath } from "../../web/app/routes.js";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { searchEntries } from "../../web/app/search-index.js";
import { buildUserSearchIndex } from "../../web/features/users/user-search-entries.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";

// ADR 0007, step 7a: a surface in an agent's Capabilities tab (slot
// agent.capabilities) is found per agent of that runtime, in both languages, and only
// while it shows. Kept beside search-index.test.js and quick-open.test.js, which are
// at their size limit.
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
const results = (query, entries) =>
  searchEntries(entries, query).flatMap((group) => group.items);
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
