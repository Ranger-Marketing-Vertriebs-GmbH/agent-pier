import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import {
  canonicalAgentRoster,
  prepareRuntimeConfig,
} from "../../server/features/assistants/runtime-config.js";
import { readJSON } from "../../server/lib/storage.js";

// OpenClaw 2026.10 refuses `agents.list` and boolean `default` markers at start
// ("Run openclaw doctor --fix"); 2026.9.9 accepted and persisted the same canonical
// shape this test expects.
test("a fresh configuration writes the keyed roster without a default marker", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-roster-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  prepareRuntimeConfig(paths, 1234);
  const { agents } = readJSON(paths.config);
  assert.equal(Object.hasOwn(agents, "list"), false);
  assert.deepEqual(agents.entries, { main: {} });
  assert.equal(agents.ownership, undefined);
});

test("a legacy single-agent list becomes keyed entries", () => {
  const config = canonicalAgentRoster({
    agents: { defaults: {}, list: [{ id: "main", default: true }] },
  });
  assert.deepEqual(config.agents, { defaults: {}, entries: { main: {} } });
  assert.equal(config.talk, undefined);
});

test("a legacy multi-agent roster keeps its default agent's surfaces", () => {
  const config = canonicalAgentRoster({
    agents: {
      defaults: { workspace: "/w" },
      list: [
        { id: "main", default: true },
        { id: "helper", name: "Helper" },
      ],
    },
  });
  assert.deepEqual(config.agents, {
    defaults: { workspace: "/w", systemAgent: { agentId: "main" } },
    entries: { main: {}, helper: { name: "Helper" } },
    ownership: "explicit",
  });
  assert.deepEqual(config.talk, { agentId: "main" });
});

test("canonical rosters, as 2026.9.9 persists them, pass through unchanged", () => {
  const canonical = {
    agents: {
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: { workspace: "/w" }, helper: { name: "helper" } },
      ownership: "explicit",
    },
    talk: { agentId: "main" },
  };
  const copy = structuredClone(canonical);
  assert.deepEqual(canonicalAgentRoster(copy), canonical);
});

test("entries win over a stale list and lose their markers", () => {
  const config = canonicalAgentRoster({
    agents: {
      entries: { main: { default: true } },
      list: [{ id: "other" }],
    },
  });
  assert.deepEqual(config.agents, { entries: { main: {} } });
});
