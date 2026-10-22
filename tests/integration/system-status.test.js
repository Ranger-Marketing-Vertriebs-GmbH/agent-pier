import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { measureDataAreas } from "../../server/features/system-status/data-areas.js";
import {
  SystemStatus,
  historyPoints,
  sessionPanes,
} from "../../server/features/system-status/system-status.js";
import { parseProcessTable } from "../../server/features/system-status/process-stats.js";
import { applicationFixture } from "../helpers/application.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function temporary(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-status-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root, relative, bytes) {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), Buffer.alloc(bytes, 1));
}
const sizeOf = (result, id) => result.areas.find((item) => item.id === id)?.bytes || 0;

test("data areas count each area, never follow links and count hard links once", async (t) => {
  const root = await temporary(t);
  const data = path.join(root, "data");
  await write(data, "profiles/a/claude/history.jsonl", 64 * 1024);
  await write(data, "assistants/workspaces/agent-1/attachments/photo.jpg", 32 * 1024);
  await write(data, "assistants/workspaces/agent-1/notes.md", 8 * 1024);
  await write(data, "assistants/shares/s1/file.txt", 8 * 1024);
  await write(data, "operations/backups/b1.tar", 16 * 1024);
  await write(data, "server.log", 4096);
  await write(data, "sessions/s1.json", 4096);
  // A large file outside the data directory, reachable only through a symbolic link.
  await write(root, "outside/huge.bin", 4 * 1024 * 1024);
  await fs.symlink(path.join(root, "outside"), path.join(data, "profiles/linked"));
  await fs.link(
    path.join(data, "operations/backups/b1.tar"),
    path.join(data, "operations/backups/b1-copy.tar"),
  );
  const result = await measureDataAreas(data);
  assert.equal(result.partial, false);
  assert.ok(sizeOf(result, "profiles") >= 64 * 1024);
  assert.ok(sizeOf(result, "profiles") < 1024 * 1024, "the link target is not counted");
  assert.ok(sizeOf(result, "agentAttachments") >= 32 * 1024);
  assert.ok(sizeOf(result, "agentAttachments") < 40 * 1024);
  assert.ok(sizeOf(result, "agentWorkspaces") >= 8 * 1024);
  assert.ok(sizeOf(result, "agentShares") >= 8 * 1024);
  assert.ok(sizeOf(result, "backups") >= 16 * 1024);
  assert.ok(sizeOf(result, "backups") < 32 * 1024, "the hard link is counted once");
  assert.ok(sizeOf(result, "logs") >= 4096);
  assert.ok(sizeOf(result, "other") >= 4096);
  assert.equal(result.areas.at(-1).id, "other");
  assert.equal(
    result.totalBytes,
    result.areas.reduce((sum, item) => sum + item.bytes, 0),
  );
  assert.ok(!JSON.stringify(result).includes(root), "no absolute path leaves the walk");
});

test("a data directory larger than the entry bound is reported as partial", async (t) => {
  const root = await temporary(t);
  for (let index = 0; index < 30; index++) await write(root, `clis/f${index}`, 10);
  const result = await measureDataAreas(root, { maxEntries: 10 });
  assert.equal(result.partial, true);
  let stop = false;
  const stopped = await measureDataAreas(root, { stopped: () => stop || (stop = true) });
  assert.equal(stopped.partial, true);
});

test("session panes come from one tmux listing and carry only name and tool", async () => {
  const calls = [];
  const panes = await sessionPanes({
    tmux: async (args) => {
      calls.push(args);
      return "tuiui-one|0|101\ntuiui-one|0|102\nother|0|5\ntuiui-two|0|201\n";
    },
    metadata: async (id) => {
      if (id === "two") throw Error("removed");
      return { name: "Fix tests", tool: "claude", cwd: "/private/project" };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(panes, [
    { id: "one", pid: 101, name: "Fix tests", tool: "claude" },
    { id: "two", pid: 201, name: "", tool: "" },
  ]);
  assert.deepEqual(
    await sessionPanes({
      tmux: async () => {
        throw Error("no server running");
      },
    }),
    [],
  );
});

const table = [
  "100 1 1000 0 0:01.00", // server
  "200 100 2000 0 0:01.00", // Gateway
  "300 50 3000 0 0:01.00", // session pane
  "301 300 3000 0 0:01.00",
].join("\n");

function sampler(overrides = {}) {
  const calls = { processes: 0, disk: 0, areas: 0 };
  const status = new SystemStatus({
    dataDir: "/unused",
    notifications: null,
    serverPid: 100,
    gatewayPid: () => 200,
    intervalMs: 20,
    idleAfterMs: 80,
    primeMs: 1,
    cpus: () => [{ times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }],
    loadavg: () => [1.234, 1, 1],
    memory: async () => ({ totalBytes: 1000, usedBytes: 250 }),
    disk: async () => {
      calls.disk++;
      return { totalBytes: 1000, freeBytes: 500, usedBytes: 500 };
    },
    panes: async () => [{ id: "one", pid: 300, name: "Fix tests", tool: "codex" }],
    processes: async ({ pids }) => {
      calls.processes++;
      const parsed = parseProcessTable(table);
      pids(parsed);
      return parsed;
    },
    measureAreas: async () => {
      calls.areas++;
      await wait(30);
      return {
        computedAt: new Date().toISOString(),
        partial: false,
        totalBytes: 10,
        areas: [{ id: "clis", bytes: 10 }],
      };
    },
    ...overrides,
  });
  return { status, calls };
}

test("the sampler maps the server, the Gateway and each session to its process tree", async (t) => {
  const { status } = sampler();
  t.after(() => status.close());
  const details = await status.details();
  assert.deepEqual(
    details.processes.map(({ kind, id, processes, rssBytes }) => ({
      kind,
      id,
      processes,
      rssBytes,
    })),
    [
      { kind: "server", id: undefined, processes: 1, rssBytes: 1000 * 1024 },
      { kind: "gateway", id: undefined, processes: 1, rssBytes: 2000 * 1024 },
      { kind: "session", id: "one", processes: 2, rssBytes: 6000 * 1024 },
    ],
  );
  assert.equal(details.processes[2].tool, "codex");
  assert.equal(details.agentPier.rssBytes, 9000 * 1024);
  assert.equal(details.memory.percent, 25);
  assert.equal(details.disk.freePercent, 50);
  assert.deepEqual(details.cpu.load, [1.23, 1, 1]);
  assert.equal(details.warning.diskLow, false);
});

test("live sampling runs only while viewed and the slow disk check idles otherwise", async (t) => {
  const { status, calls } = sampler({ diskCheckMs: 40 });
  t.after(() => status.close());
  await status.summary();
  await wait(70);
  const viewed = calls.processes;
  assert.ok(viewed >= 2, `sampled ${viewed} times while viewed`);
  await wait(200);
  const idle = calls.processes;
  await wait(120);
  assert.equal(calls.processes, idle, "no process sampling without viewers");
  const disk = calls.disk;
  status.start();
  await wait(130);
  assert.ok(calls.disk > disk, "the slow disk check still runs");
  assert.equal(calls.processes, idle);
});

test("data area sizes are measured in the background and cached", async (t) => {
  const { status, calls } = sampler({ areasMaxAgeMs: 60_000 });
  t.after(() => status.close());
  const first = await status.details();
  assert.equal(first.areas.state, "pending");
  await wait(60);
  const second = await status.details();
  assert.equal(second.areas.state, "ready");
  assert.deepEqual(second.areas.areas, [{ id: "clis", bytes: 10 }]);
  await status.details();
  assert.equal(calls.areas, 1);
});

test("the history averages samples into buckets of the last hour", () => {
  const now = 10 * 60 * 60 * 1000;
  const points = historyPoints(
    [
      { t: now - 2 * 60 * 60 * 1000, cpu: 99, memory: 99, agentCpu: 99 },
      { t: now - 20_000, cpu: 10, memory: 40, agentCpu: 1 },
      { t: now - 15_000, cpu: null, memory: 60, agentCpu: 3 },
      { t: now, cpu: 50, memory: 50, agentCpu: 2 },
    ],
    now,
  );
  assert.deepEqual(points, [
    { t: now - 30_000, cpu: 10, memory: 50, agentCpu: 2 },
    { t: now, cpu: 50, memory: 50, agentCpu: 2 },
  ]);
});

test("the system status routes need the login and return no host paths", async (t) => {
  const f = await applicationFixture(t, {
    systemStatus: {
      intervalMs: 50,
      primeMs: 1,
      disk: async () => ({ totalBytes: 1000, freeBytes: 50, usedBytes: 950 }),
      measureAreas: async () => ({
        computedAt: new Date().toISOString(),
        partial: false,
        totalBytes: 10,
        areas: [{ id: "profiles", bytes: 10 }],
      }),
    },
  });
  const anonymous = await fetch(`${f.url}/api/system-status`);
  assert.equal(anonymous.status, 401);
  const response = await f.request("/api/system-status");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const summary = await response.json();
  assert.equal(summary.disk.freePercent, 5);
  assert.deepEqual(summary.warning, { diskLow: true, thresholdPercent: 10 });
  assert.ok(summary.memory.totalBytes > 0);
  const details = await (await f.request("/api/system-status/details")).json();
  assert.equal(details.processes[0].kind, "server");
  assert.ok(details.processes[0].rssBytes > 0, "the real server process is measured");
  const text = JSON.stringify(details);
  for (const secret of [f.root, f.dataDir, os.homedir()])
    assert.ok(!text.includes(secret), "no host path in the response");
  await wait(20);
  const later = await (await f.request("/api/system-status/details")).json();
  assert.equal(later.areas.state, "ready");
});

test("a once-a-minute background sample fills the history without viewers", async () => {
  const { status, calls } = sampler({ backgroundMs: 30, diskCheckMs: 60_000 });
  status.start();
  await wait(130);
  assert.equal(status.liveTimer, null, "no live sampling without a view");
  assert.ok(calls.processes >= 2, `sampled ${calls.processes} times in the background`);
  assert.ok(status.history.length >= 2);
  await status.close();
  const closed = calls.processes;
  await wait(90);
  assert.equal(calls.processes, closed, "the background sample stops on shutdown");
});
