import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { searchEntries } from "../../web/app/search-index.js";

const connections = { ssh: [], mcp: [], secrets: [], github: [], models: [] };
const firstId = (query, entries) => searchEntries(entries, query)[0]?.items[0]?.id;

test("searching stays fast with thousands of entries", () => {
  const indexOf = (count) =>
    buildSearchIndex({
      agents: Array.from({ length: count }, (_, n) => ({
        id: `agent-${n}`,
        name: `Agent Nummer ${n}`,
        capabilities: { memory: true },
      })),
      connections,
      agentsEnabled: true,
    });
  const small = indexOf(30);
  const big = indexOf(300);
  assert.ok(big.length > 3000, `${big.length} entries`);
  assert.equal(firstId("agent 42 zug", big), "agent:agent-42:access");
  // The baseline is the same queries over a tenth of the agents, measured in CPU
  // time: other processes on a loaded host neither slow it nor the big index down.
  const queries = ["ssh", "agent 42 zug", "einstellungen zugriff", "x"];
  const cpuMs = (entries) => {
    const start = process.cpuUsage();
    for (const query of queries) searchEntries(entries, query);
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1000;
  };
  cpuMs(small);
  cpuMs(big);
  const smallMs = [];
  const bigMs = [];
  for (let round = 0; round < 7; round++) {
    smallMs.push(cpuMs(small));
    bigMs.push(cpuMs(big));
  }
  const median = (list) => list.sort((a, b) => a - b)[list.length >> 1];
  // Linear search grows with the entries (about 9×); quadratic would be about 81×.
  const entries = big.length / small.length;
  const growth = median(bigMs) / Math.max(median(smallMs), 0.1);
  assert.ok(
    growth < 3 * entries,
    `${big.length} entries took ${growth.toFixed(1)}× the time of ${small.length}`,
  );
});
