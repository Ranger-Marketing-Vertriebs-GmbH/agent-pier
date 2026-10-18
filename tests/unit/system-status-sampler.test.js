import test from "node:test";
import assert from "node:assert/strict";
import { SystemStatus } from "../../server/features/system-status/system-status.js";

// One server process whose CPU time and the clock advance as the test says.
function sampler({ cores = 1, processes } = {}) {
  const state = { now: 1_000_000, cpuSeconds: 100, errors: [] };
  const status = new SystemStatus({
    dataDir: "/unused",
    notifications: null,
    serverPid: 1,
    primeMs: 1,
    now: () => state.now,
    cpus: () =>
      Array.from({ length: cores }, () => ({
        times: { user: state.now / 2, nice: 0, sys: 0, idle: state.now / 2, irq: 0 },
      })),
    loadavg: () => [0, 0, 0],
    memory: async () => ({ totalBytes: 100, usedBytes: 50 }),
    disk: async () => ({ totalBytes: 100, freeBytes: 50, usedBytes: 50 }),
    panes: async () => [],
    measureAreas: async () => ({ computedAt: new Date(0).toISOString(), areas: [] }),
    processes:
      processes ||
      (async () =>
        new Map([
          [
            1,
            { pid: 1, ppid: 0, rssBytes: 1, cpuPercent: 1, cpuSeconds: state.cpuSeconds },
          ],
        ])),
    onError: (error) => state.errors.push(error.message),
  });
  return { status, state };
}

test("process CPU comes from the CPU time used since the previous sample", async () => {
  const { status, state } = sampler();
  await status.sample();
  state.now += 5000;
  state.cpuSeconds += 2.5;
  const { processes } = await status.sample();
  assert.equal(processes[0].cpuPercent, 50);
});

test("after an idle gap process CPU averages over the whole gap", async () => {
  const { status, state } = sampler({ cores: 2 });
  await status.sample();
  // A minute later the live sampling primes the host CPU reading again; the process
  // delta still covers the minute since the last process table.
  state.now += 60_000;
  state.cpuSeconds += 6;
  const { processes } = await status.sample();
  assert.equal(processes[0].cpuPercent, 5); // 10 % of one core = 5 % of two cores
});

test("one tree never reports more than every core", async () => {
  const { status, state } = sampler({ cores: 2 });
  await status.sample();
  state.now += 1000;
  state.cpuSeconds += 50; // a counter jump, such as a reused pid
  const { processes } = await status.sample();
  assert.equal(processes[0].cpuPercent, 100);
});

test("a failed ps still returns the host bars without process rows", async () => {
  const { status, state } = sampler({
    processes: async () => {
      throw Error("ps unavailable");
    },
  });
  const summary = await status.summary();
  assert.equal(summary.memory.percent, 50);
  assert.equal(summary.disk.freePercent, 50);
  assert.deepEqual(summary.agentPier, { cpuPercent: 0, rssBytes: 0 });
  assert.deepEqual((await status.details()).processes, []);
  assert.deepEqual(state.errors, ["ps unavailable"]);
  await status.close();
});
