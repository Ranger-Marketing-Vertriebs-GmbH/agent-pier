import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import {
  DEFAULT_PORT_RANGE,
  PORT_BLOCK,
  PortLeases,
  browserSession,
  pipelinePorts,
  portAvailable,
  turnEnvironment,
} from "../../server/features/pipelines/run-ports.js";
import {
  resumedRepairPrompt,
  stagePrompt,
} from "../../server/features/pipelines/stage-prompt.js";
import { seedProfiles } from "../../server/features/pipelines/profile-seeds.js";
import { loadConfig } from "../../server/lib/config.js";

const free = async () => true;
// A run holding `ports` in its active turn, as the run store keeps it.
const holding = (base, extra = {}) => ({
  id: `run-${base}`,
  status: "running",
  activeTurns: { build: { turnId: `turn-${base}`, ports: { base, count: PORT_BLOCK } } },
  ...extra,
});
const leases = (runs, options = {}) =>
  new PortLeases({
    range: { start: 20100, end: 20139 },
    probe: free,
    runs: () => runs,
    ...options,
  });

test("the default range stays clear of AgentPier, Vite and test ports", () => {
  const { start, end } = DEFAULT_PORT_RANGE;
  for (const port of [4380, 4389, 4467, 5173, 5000, 5432, 3000, 8080])
    assert.equal(port >= start && port <= end, false, `${port} is in the range`);
  // Below the Linux and macOS ephemeral ranges, so outgoing connections never take it.
  assert.ok(end < 32768);
});

test("leases hand out distinct blocks and never reuse a leased block", async () => {
  const runs = [];
  const ports = leases(runs);
  const first = await ports.lease({ turnId: "a" });
  // Reserved but not yet recorded in a run: still never handed out twice.
  const second = await ports.lease({ turnId: "b" });
  assert.deepEqual(first, { base: 20100, count: PORT_BLOCK });
  assert.deepEqual(second, { base: 20110, count: PORT_BLOCK });
  runs.push(holding(20100), holding(20110));
  ports.settle("a");
  ports.settle("b");
  assert.equal((await ports.lease({ turnId: "c" })).base, 20120);
});

test("a block is released once its turn ends, the run is cancelled or recovered idle", async () => {
  const run = holding(20100);
  const runs = [run];
  const ports = leases(runs);
  assert.equal((await ports.lease({ turnId: "x" })).base, 20110);
  ports.settle("x");
  // The turn ended: the engine clears the active turn.
  run.activeTurns = {};
  assert.equal((await ports.lease({ turnId: "y" })).base, 20100);
  ports.settle("y");
  // A cancelled or failed run holds nothing even if a stale active turn remains.
  for (const status of ["cancelled", "failed", "completed"]) {
    const stale = [holding(20100, { status })];
    assert.equal((await leases(stale).lease({ turnId: "z" })).base, 20100);
  }
  // History-only imports never hold a lease.
  const imported = [holding(20100, { imported: { historyOnly: true } })];
  assert.equal((await leases(imported).lease({ turnId: "z" })).base, 20100);
});

test("a restarted engine rebuilds the leases from the stored active turns", async () => {
  const runs = [holding(20100), holding(20120)];
  // A fresh instance has no in-memory state: only the stored runs tell it what is leased.
  const ports = leases(runs);
  assert.equal((await ports.lease({ turnId: "n" })).base, 20110);
  runs.push(holding(20110));
  ports.settle("n");
  assert.equal((await ports.lease({ turnId: "m" })).base, 20130);
});

test("every active turn of a run holds its own block, a parallel group's members too", async () => {
  const run = {
    id: "run-group",
    status: "running",
    activeTurns: {
      security: { turnId: "t1", ports: { base: 20100, count: PORT_BLOCK } },
      code: { turnId: "t2", ports: { base: 20110, count: PORT_BLOCK } },
    },
  };
  const ports = leases([run]);
  assert.equal((await ports.lease({ turnId: "n" })).base, 20120);
  ports.settle("n");
  // One member finishing releases only its own block.
  delete run.activeTurns.security;
  assert.equal((await ports.lease({ turnId: "m" })).base, 20100);
});

test("blocks with a port in use on the host are skipped", async () => {
  const busy = new Set([20101, 20112]);
  const ports = leases([], { probe: async (port) => !busy.has(port) });
  assert.equal((await ports.lease({ turnId: "a" })).base, 20120);
});

test("a turn prefers the block its stage used before when it is free", async () => {
  const ports = leases([holding(20100)]);
  assert.equal((await ports.lease({ turnId: "a", prefer: 20130 })).base, 20130);
  ports.settle("a");
  // A leased or out-of-range preference falls back to the first free block.
  assert.equal((await ports.lease({ turnId: "b", prefer: 20100 })).base, 20110);
  assert.equal((await ports.lease({ turnId: "c", prefer: 4380 })).base, 20120);
});

test("an exhausted range refuses the lease", async () => {
  const runs = [holding(20100), holding(20110), holding(20120), holding(20130)];
  await assert.rejects(leases(runs).lease({ turnId: "a" }), { status: 409 });
});

test("concurrent leases never share a block, and leases beyond the range are refused", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 7 }), async (count) => {
      const ports = leases([], {
        probe: () => new Promise((resolve) => setTimeout(() => resolve(true), 1)),
      });
      const results = await Promise.allSettled(
        Array.from({ length: count }, (_, i) => ports.lease({ turnId: `t${i}` })),
      );
      const granted = results.filter((r) => r.status === "fulfilled");
      // The range holds four blocks.
      assert.equal(granted.length, Math.min(count, 4));
      assert.equal(new Set(granted.map((r) => r.value.base)).size, granted.length);
      for (const r of results.filter((r) => r.status === "rejected"))
        assert.equal(r.reason.status, 409);
    }),
    { numRuns: 20 },
  );
});

test("a block containing AgentPier's own port is never leased", async () => {
  const ports = leases([], { hostPort: 20111 });
  const granted = [];
  for (const turnId of ["a", "b", "c"])
    granted.push((await ports.lease({ turnId })).base);
  assert.deepEqual(granted, [20100, 20120, 20130]);
  await assert.rejects(ports.lease({ turnId: "d", prefer: 20110 }), { status: 409 });
  // A port just past a block leaves that block usable.
  const edge = leases([], { hostPort: 20103 });
  assert.equal((await edge.lease({ turnId: "a" })).base, 20100);
});

async function listening(t, host) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolve);
    });
  } catch {
    return null;
  }
  t.after(() => server.close());
  return server.address().port;
}
// Each bind address is probed on its own: on macOS a loopback or wildcard bind succeeds
// while another process listens on a different one of them.
for (const host of ["127.0.0.1", "0.0.0.0", "::1", "::"])
  test(`the port probe sees a listener on ${host}`, async (t) => {
    const port = await listening(t, host);
    if (port === null) return t.skip(`${host} is not available on this host`);
    assert.equal(await portAvailable(port), false);
  });

test("the port probe reports a free port as free", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portAvailable(port), true);
});

test("operator range settings are bounded and keep the default otherwise", () => {
  assert.deepEqual(pipelinePorts(undefined), {});
  assert.deepEqual(pipelinePorts({ portRangeStart: 30000, portRangeEnd: 30099 }), {
    portRange: { start: 30000, end: 30099 },
  });
  for (const saved of [
    { portRangeStart: 30000 },
    { portRangeStart: 80, portRangeEnd: 200 },
    { portRangeStart: 30000, portRangeEnd: 30005 },
    { portRangeStart: 30099, portRangeEnd: 30000 },
    { portRangeStart: "30000", portRangeEnd: 30099 },
    { portRangeStart: 65530, portRangeEnd: 65999 },
  ])
    assert.deepEqual(pipelinePorts(saved), {}, JSON.stringify(saved));
});

test("every native turn gets its run, stage, port block and browser session", () => {
  const env = turnEnvironment({
    runId: "4b5c",
    nodeId: "app-test",
    ports: { base: 20110, count: 3 },
  });
  assert.deepEqual(env, {
    AGENTPIER_RUN_ID: "4b5c",
    AGENTPIER_STAGE_ID: "app-test",
    AGENTPIER_PORT: "20110",
    AGENTPIER_PORT_COUNT: "3",
    AGENTPIER_BROWSER_SESSION: "agentpier-4b5c-app-test",
  });
  assert.equal(browserSession("r", "s"), "agentpier-r-s");
  // Without a lease (a driver called directly) no port variables are claimed.
  assert.deepEqual(turnEnvironment({ runId: "r", nodeId: "s" }), {
    AGENTPIER_RUN_ID: "r",
    AGENTPIER_STAGE_ID: "s",
    AGENTPIER_BROWSER_SESSION: "agentpier-r-s",
  });
});

test("kickoff and resumed repair prompts state the turn's ports and browser session", () => {
  const node = { id: "app-test", profileSnapshot: { config: { prompts: {} } } };
  const run = { id: "r1", task: "Test", executionLog: [], nodes: [node] };
  const ports = { base: 20110, count: 3 };
  for (const build of [stagePrompt, resumedRepairPrompt]) {
    const prompt = build(run, node, "", "verdict.json", "reports", ports);
    assert.match(prompt, /This turn's ports are 20110-20112/);
    assert.match(prompt, /AGENTPIER_PORT=20110/);
    assert.match(prompt, /agentpier-r1-app-test/);
    assert.match(prompt, /Stop every server, watcher and browser you started/);
    // Without a lease the prompt claims no ports.
    const bare = build(run, node, "", "verdict.json", "reports");
    assert.equal(bare.includes("AGENTPIER_PORT"), false);
  }
});

test("operator range settings reach the pipeline engine options", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-port-config-"));
  const saved = process.env.AGENTPIER_DATA_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.AGENTPIER_DATA_DIR;
    else process.env.AGENTPIER_DATA_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      pipelines: { portRangeStart: 30000, portRangeEnd: 30099, turnTimeoutMinutes: 10 },
    }),
  );
  process.env.AGENTPIER_DATA_DIR = dir;
  assert.deepEqual(loadConfig().pipelines, {
    turnTimeoutMs: 600000,
    portRange: { start: 30000, end: 30099 },
  });
});

test("the seed app tester starts its servers on the leased port", () => {
  const tester = seedProfiles("2026-10-20T00:00:00Z").find(
    (p) => p.seedKey === "app-tester",
  );
  for (const name of ["AGENTPIER_PORT", "AGENTPIER_BROWSER_SESSION"])
    assert.ok(tester.config.prompts.role.includes(`$${name}`), name);
  // Also launchable as a plain session, where no port is leased.
  assert.match(tester.config.prompts.role, /When \$AGENTPIER_PORT is set/);
  assert.match(tester.config.prompts.role, /otherwise use the documented ports/);
});
