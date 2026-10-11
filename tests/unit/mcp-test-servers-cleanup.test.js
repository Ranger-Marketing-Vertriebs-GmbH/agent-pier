import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  endStdioServers,
  runningStdioServers,
  stdioMcpScript,
} from "../helpers/mcp-test-servers.js";

function records(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-servers-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "local.jsonl");
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

test("only recorded servers without an end record are candidates", (t) => {
  const file = records(t, [
    { event: "start", pid: 11, startTime: "a" },
    { event: "start", pid: 12, startTime: "b" },
    { event: "call", pid: 12, tool: "echo" },
    { event: "SIGTERM", pid: 12 },
    { event: "start", pid: 13, startTime: "c" },
    { event: "exit", pid: 13 },
    // A reused pid: the later start counts.
    { event: "start", pid: 13, startTime: "d" },
    { event: "start", pid: 14 },
  ]);
  assert.deepEqual(runningStdioServers(file), [
    { pid: 11, startTime: "a" },
    { pid: 13, startTime: "d" },
    { pid: 14, startTime: null },
  ]);
});

test("a pid is signalled only while its identity matches the recorded server", async (t) => {
  const file = records(t, [
    { event: "start", pid: 21, startTime: "t21" },
    { event: "start", pid: 22, startTime: "t22" },
    { event: "start", pid: 23, startTime: "t23" },
    { event: "start", pid: 24, startTime: "t24" },
    { event: "start", pid: 25 },
    { event: "start", pid: 26, startTime: "t26" },
    { event: "exit", pid: 26 },
  ]);
  const command = `/usr/bin/node ${stdioMcpScript} ${file}`;
  const alive = new Set([21, 22, 23, 24, 25, 26]);
  const identities = {
    21: { startTime: "t21", command },
    // The pid was reused by an unrelated process.
    22: { startTime: "later", command: "/usr/bin/vim notes.txt" },
    // Same start time but another program.
    23: { startTime: "t23", command: "/usr/bin/node other.js" },
    // This helper, but for another record file.
    24: { startTime: "t24", command: `/usr/bin/node ${stdioMcpScript} /tmp/other.jsonl` },
    25: { startTime: "t25", command },
    26: { startTime: "t26", command },
  };
  const identity = (pid) => {
    if (!alive.has(pid)) throw Error("no such process");
    return identities[pid];
  };
  const signals = [];
  const kill = (pid, signal) => {
    signals.push([pid, signal]);
    // 21 ignores SIGTERM and only ends on SIGKILL.
    if (signal === "SIGKILL") alive.delete(pid);
  };
  await endStdioServers(file, { identity, kill, delay: 1 });
  assert.deepEqual(signals, [
    [21, "SIGTERM"],
    [21, "SIGKILL"],
  ]);
});

test("a server that exits on SIGTERM is not signalled again", async (t) => {
  const file = records(t, [{ event: "start", pid: 31, startTime: "t31" }]);
  const command = `node ${stdioMcpScript} ${file}`;
  const alive = new Set([31]);
  const signals = [];
  await endStdioServers(file, {
    identity: (pid) => {
      if (!alive.has(pid)) throw Error("gone");
      return { startTime: "t31", command };
    },
    kill: (pid, signal) => {
      signals.push(signal);
      alive.delete(pid);
    },
    delay: 1,
  });
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("a real stdio server records its identity and is ended by the safety net", async (t) => {
  const file = records(t, []);
  const child = spawn(process.execPath, [stdioMcpScript, file], { stdio: "pipe" });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  for (let n = 0; n < 100 && !runningStdioServers(file).length; n++)
    await new Promise((r) => setTimeout(r, 50));
  const [server] = runningStdioServers(file);
  assert.equal(server.pid, child.pid);
  assert.equal(typeof server.startTime, "string");
  await endStdioServers(file);
  await exited;
  assert.deepEqual(runningStdioServers(file), []);
});
