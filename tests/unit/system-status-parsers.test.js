import test from "node:test";
import assert from "node:assert/strict";
import {
  cpuSeconds,
  linuxStatSeconds,
  parseProcessTable,
  processTrees,
  readProcessTable,
  treeUsage,
} from "../../server/features/system-status/process-stats.js";
import {
  cpuBusy,
  cpuTimes,
  diskFromStatfs,
  macMemoryUsed,
  memoryStats,
  parseVmStat,
} from "../../server/features/system-status/host-stats.js";
import { areaOf } from "../../server/features/system-status/data-areas.js";

test("ps CPU time parses the Linux and macOS formats", () => {
  assert.equal(cpuSeconds("00:00:07"), 7);
  assert.equal(cpuSeconds("01:02:03"), 3723);
  assert.equal(cpuSeconds("2-00:00:01"), 172801);
  assert.equal(cpuSeconds("842:24.86"), 842 * 60 + 24.86);
  assert.equal(cpuSeconds("0:00.50"), 0.5);
  assert.equal(cpuSeconds("-"), null);
});

test("the process table keeps pid, parent, RSS and CPU of every line", () => {
  const table = parseProcessTable(
    "    1     0  22064   1.1 842:24.86\n  100     1 6029760 100,6 0:41.07\n garbage\n",
  );
  assert.deepEqual([...table.keys()], [1, 100]);
  assert.deepEqual(table.get(100), {
    pid: 100,
    ppid: 1,
    rssBytes: 6029760 * 1024,
    cpuPercent: 100.6,
    cpuSeconds: 41.07,
  });
});

test("Linux /proc stat CPU time survives a command name with spaces", () => {
  const stat =
    "42 (node (worker) x) S 1 42 42 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 11 0 1000";
  assert.equal(linuxStatSeconds(stat), 3);
});

test("on Linux the AgentPier pids get their CPU time from /proc", async () => {
  const table = await readProcessTable({
    platform: "linux",
    run: async () => ({ stdout: "10 1 100 0.0 00:00:01\n11 10 100 0.0 00:00:01\n" }),
    read: async (file) => {
      if (file !== "/proc/10/stat")
        throw Object.assign(Error("gone"), { code: "ENOENT" });
      return "10 (node) S 1 10 10 0 -1 0 0 0 0 0 123 4 0 0";
    },
    pids: () => new Set([10, 11]),
  });
  assert.equal(table.get(10).cpuSeconds, 1.27);
  assert.equal(table.get(11).cpuSeconds, 1);
});

test("process trees keep the Gateway and sessions apart from the server", () => {
  const table = parseProcessTable(
    [
      "100 1 1000 0 0:01.00", // server
      "101 100 1000 0 0:01.00", // adapter under the server
      "200 100 2000 0 0:01.00", // Gateway, a child of the server
      "201 200 2000 0 0:01.00",
      "300 50 3000 0 0:01.00", // session pane, under the tmux server
      "301 300 3000 0 0:01.00",
      "400 1 9000 0 0:01.00", // unrelated
    ].join("\n"),
  );
  const trees = processTrees(table, [
    ["gateway", 200],
    ["session:a", 300],
    ["missing", 999],
    ["server", 100],
  ]);
  assert.deepEqual([...trees.get("gateway")].sort(), [200, 201]);
  assert.deepEqual([...trees.get("session:a")].sort(), [300, 301]);
  assert.deepEqual([...trees.get("missing")], []);
  assert.deepEqual([...trees.get("server")].sort(), [100, 101]);
});

test("tree CPU comes from the CPU time delta, or ps %cpu without a previous value", () => {
  const before = parseProcessTable("1 0 100 50.0 0:10.00\n2 1 100 0.0 0:00.00");
  const after = parseProcessTable(
    "1 0 100 50.0 0:12.50\n2 1 100 0.0 0:00.00\n3 1 1 7 0:00.10",
  );
  // 2.5 s CPU in 5 s = 50 % of one core; the new pid 3 adds its ps 7 %.
  assert.deepEqual(treeUsage(after, new Set([1, 2, 3]), before, 5000), {
    processes: 3,
    rssBytes: 201 * 1024,
    cpuPercent: 57,
  });
  assert.equal(treeUsage(after, new Set([1]), null, 5000).cpuPercent, 50);
});

test("host CPU is the busy share between two readings", () => {
  const core = (user, idle) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  const before = cpuTimes([core(100, 900), core(100, 900)]);
  const after = cpuTimes([core(150, 950), core(200, 900)]);
  assert.equal(cpuBusy(before, after), 75);
  assert.equal(cpuBusy(null, after), null);
  assert.equal(cpuBusy(after, after), null);
});

const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   166184.
Pages active:                                 858659.
Pages inactive:                               845503.
Pages speculative:                             12255.
Pages wired down:                             272854.
Pages purgeable:                                3577.
"Translation faults":                    53068832543.
File-backed pages:                            567620.
Anonymous pages:                             1148797.
Pages occupied by compressor:                 954850.
`;

test("macOS memory counts app, wired and compressed memory like Activity Monitor", () => {
  const parsed = parseVmStat(vmStat);
  assert.equal(parsed.pageSize, 16384);
  assert.equal(parsed.pages["translation faults"], 53068832543);
  const total = 51539607552;
  assert.equal(macMemoryUsed(parsed, total), (1148797 - 3577 + 272854 + 954850) * 16384);
  // Without the anonymous counter, free, inactive and speculative pages are available.
  const older = parseVmStat(vmStat.replace(/Anonymous pages.*\n/, ""));
  assert.equal(macMemoryUsed(older, total), total - (166184 + 845503 + 12255) * 16384);
});

test("memory stats prefer vm_stat on macOS and os.freemem elsewhere", async () => {
  const totalmem = () => 51539607552;
  const freemem = () => 2915205120;
  const mac = await memoryStats({
    platform: "darwin",
    run: async () => ({ stdout: vmStat }),
    totalmem,
    freemem,
  });
  assert.equal(mac.usedBytes, (1148797 - 3577 + 272854 + 954850) * 16384);
  const linux = await memoryStats({ platform: "linux", totalmem, freemem });
  assert.equal(linux.usedBytes, 51539607552 - 2915205120);
  const failed = await memoryStats({
    platform: "darwin",
    run: async () => {
      throw Error("missing");
    },
    totalmem,
    freemem,
  });
  assert.equal(failed.usedBytes, 51539607552 - 2915205120);
});

test("disk figures use the space an unprivileged process may write", () => {
  assert.deepEqual(
    diskFromStatfs({ bsize: 4096, blocks: 1000, bfree: 300, bavail: 250 }),
    {
      totalBytes: 4096000,
      freeBytes: 1024000,
      usedBytes: 3072000,
    },
  );
});

test("data directory paths map to their areas", () => {
  const area = (relative, directory = false) => areaOf(relative.split("/"), directory);
  assert.equal(area("profiles"), "profiles");
  assert.equal(area("clis"), "clis");
  assert.equal(area("toolchains"), "tools");
  assert.equal(area("mcp-packages"), "tools");
  assert.equal(area("chat-attachments"), "chatAttachments");
  assert.equal(area("server.log"), "logs");
  assert.equal(area("operations", true), null);
  assert.equal(area("operations/backups"), "backups");
  assert.equal(area("operations/releases"), "other");
  assert.equal(area("assistants", true), null);
  assert.equal(area("assistants/assistants.sqlite"), "other");
  assert.equal(area("assistants/backups"), "backups");
  assert.equal(area("assistants/shares"), "agentShares");
  assert.equal(area("assistants/runtimes"), "runtimes");
  assert.equal(area("assistants/logs"), "logs");
  assert.equal(area("assistants/workspaces", true), null);
  assert.equal(area("assistants/workspaces/agent-1", true), null);
  assert.equal(area("assistants/workspaces/agent-1/notes.md"), "agentWorkspaces");
  assert.equal(area("assistants/workspaces/agent-1/attachments"), "agentAttachments");
  assert.equal(area("assistants/workspaces/agent-1/project"), "agentWorkspaces");
  assert.equal(area("sessions"), "other");
});
