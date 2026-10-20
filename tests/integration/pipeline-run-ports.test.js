import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "../helpers/pipeline-engine.js";

const range = { start: 20100, end: 20129 };
const start = (f, task = "Test the app") =>
  f.engine.start({ pipelineId: "definition", cwd: f.dir, task });
// The run's one active turn (a single stage runs at a time in these pipelines).
const turn = (run) => Object.values(run.activeTurns)[0] ?? null;
const portLine = (prompt) => prompt.match(/This turn's ports are (\d+)-(\d+)/)?.slice(1);

test("two runs working at the same time get different port blocks", async (t) => {
  const f = fixture(t, { options: { portRange: range, portProbe: async () => true } });
  const [a, b] = await Promise.all([start(f), start(f)]);
  const ports = [a, b].map((run) => turn(f.engine.get(run.id)).ports);
  assert.notEqual(ports[0].base, ports[1].base);
  for (const lease of ports) {
    assert.equal(lease.count, 3);
    assert.ok(lease.base >= range.start && lease.base + 2 <= range.end);
  }
  // The driver is handed each turn's block, and the prompt states it.
  for (const [index, run] of [a, b].entries()) {
    const launch = f.launches.find((l) => l.runId === run.id);
    assert.deepEqual(launch.ports, ports[index]);
    assert.deepEqual(portLine(launch.prompt), [
      String(ports[index].base),
      String(ports[index].base + 2),
    ]);
    assert.ok(launch.prompt.includes(`agentpier-${run.id}-build`));
    assert.match(launch.prompt, /Stop every server, watcher and browser you started/);
    assert.deepEqual(f.engine.get(run.id).executionLog[0].ports, ports[index]);
  }
});

test("a cancelled run releases its block and a third run cannot take a leased one", async (t) => {
  const f = fixture(t, {
    options: { portRange: { start: 20100, end: 20119 }, portProbe: async () => true },
  });
  const a = await start(f),
    b = await start(f);
  assert.deepEqual(
    [a, b].map((run) => turn(f.engine.get(run.id)).ports.base),
    [20100, 20110],
  );
  // The range is exhausted: the next run parks instead of sharing a block.
  const c = await start(f);
  assert.equal(f.engine.get(c.id).status, "awaiting-human");
  assert.equal(f.engine.get(c.id).nodes[0].failReason, "session-error");
  await f.engine.cancel(a.id);
  assert.equal(turn(f.engine.get(a.id)), null);
  await f.engine.retry(c.id);
  assert.equal(turn(f.engine.get(c.id)).ports.base, 20100);
});

test("a recovered turn keeps its block across a restart and a stage reuses it", async (t) => {
  const f = fixture(t, {
    loop: true,
    options: { portRange: range, portProbe: async () => true },
  });
  const other = await start(f);
  const a = await start(f);
  const runA = () => f.engine.get(a.id);
  const held = turn(runA()).ports.base;
  assert.equal(held, 20110);
  await f.restart();
  // The restarted engine reads the running turns' leases from the run store.
  assert.equal(turn(runA()).ports.base, held);
  const b = await start(f);
  assert.equal(turn(f.engine.get(b.id)).ports.base, 20120);
  await f.engine.cancel(other.id);

  const finish = async (verdict) => {
    const launch = f.launches.filter((l) => l.runId === a.id).at(-1);
    const file = path.join(launch.cwd, launch.verdictPath);
    fs.writeFileSync(file, JSON.stringify(verdict));
    const at = Math.ceil(f.engine.nowMs() / 1000);
    fs.utimesSync(file, at, at);
    f.outcomes.set(launch.sessionId, { status: "completed", exitCode: 0 });
    await f.engine.reconcile();
  };
  // build passes and releases its block; review takes the lowest free one...
  await finish({ result: "pass", summary: "Built" });
  assert.equal(turn(runA()).nodeId, "review");
  assert.equal(turn(runA()).ports.base, 20100);
  // ...and the loop back to build prefers build's earlier block over the lowest.
  await finish({ result: "fail", summary: "Broken", findings: [] });
  assert.equal(turn(runA()).nodeId, "build");
  assert.equal(turn(runA()).ports.base, held);
  const prompt = f.launches.at(-1).prompt;
  assert.deepEqual(portLine(prompt), [String(held), String(held + 2)]);
});
