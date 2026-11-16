import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyProcesses,
  endProcess,
  parseLsof,
  scanFolderProcesses,
} from "../../server/features/projects/folder-processes.js";

const lsofRecord = (pid, name, uid, files) =>
  `p${pid}\0c${name}\0u${uid}\0\n` + files.map(([fd, n]) => `f${fd}\0n${n}\0\n`).join("");

test("parses names with spaces, unicode and newlines", () => {
  const out =
    "p42\0cvim\0u501\0\nfcwd\0n/work/my app\0\np43\0cnode\0u0\0\nf12\0n/work/my app2/x\0\n";
  // -F0 output: NUL-terminated fields, each field set ended by "\n"
  const found = parseLsof(out, ["/work/my app"]);
  assert.deepEqual([...found.keys()], [42]);
  assert.equal(found.get(42).uses, "cwd");
  assert.equal(
    parseLsof("p7\0cx\0u1\0f3\0n/work/my app/ü\nzeile\0", ["/work/my app"]).get(7).uses,
    "files",
  );
});

test("a process name with a newline does not start another record", () => {
  const out =
    lsofRecord(5, "evil\np9", 501, [["cwd", "/elsewhere"]]) +
    lsofRecord(6, "ok", 501, [["4", "/work/app/a.txt"]]);
  const found = parseLsof(out, ["/work/app"]);
  assert.deepEqual([...found.keys()], [6]);
  assert.deepEqual(found.get(6), { pid: 6, name: "ok", uid: 501, uses: "files" });
});

test("folder names are matched in the escaped form lsof prints them", () => {
  const folder = "/work/a\\b\nc\x01d\x7fü";
  const utf8 = "/work/a\\\\b\\nc^Ad\\x7fü";
  const bytes = "/work/a\\\\b\\nc^Ad\\x7f\\xc3\\xbc";
  const out =
    lsofRecord(1, "a", 501, [["cwd", utf8]]) +
    lsofRecord(2, "b", 501, [["7", `${bytes}/f`]]) +
    lsofRecord(3, "c", 501, [["cwd", "/work/a\\\\b\\nc^Ad\\x7füx"]]);
  const found = parseLsof(out, [folder]);
  assert.deepEqual([...found.keys()], [1, 2]);
  assert.equal(found.get(1).uses, "cwd");
});

test("a cwd anywhere in the record wins over open files", () => {
  const out = lsofRecord(8, "sh", 501, [
    ["3", "/work/app/log"],
    ["cwd", "/work/app/src"],
  ]);
  assert.equal(parseLsof(out, ["/other", "/work/app"]).get(8).uses, "cwd");
});

const table = (rows) => new Map(rows.map(([pid, ppid]) => [pid, { pid, ppid }]));
const found = (...pids) =>
  pids.map((pid) => ({ pid, name: `p${pid}`, uid: 501, uses: "files" }));
const identity = (pid) => ({ startTime: `t${pid}` });

test("the server, its ancestors, tmux, the Gateway and pid 1 are protected", () => {
  const rows = [
    [1, 0],
    [50, 1], // shell that started the server
    [100, 50], // server
    [101, 100], // preview started by the server
    [200, 1], // tmux
    [300, 1], // gateway
    [400, 1], // editor
  ];
  const result = classifyProcesses(found(1, 50, 100, 101, 200, 300, 400), {
    serverPid: 100,
    gatewayPid: 300,
    tmuxPid: 200,
    sessionPanes: [],
    table: table(rows),
    uid: 501,
    identity,
  });
  const byPid = new Map(result.map((p) => [p.pid, p]));
  for (const pid of [1, 50, 100, 200, 300]) {
    assert.equal(byPid.get(pid).protected, true, `pid ${pid}`);
    assert.equal(byPid.get(pid).endable, false, `pid ${pid}`);
  }
  for (const pid of [101, 400]) {
    assert.equal(byPid.get(pid).protected, false);
    assert.equal(byPid.get(pid).endable, true);
  }
  assert.deepEqual(byPid.get(400), {
    pid: 400,
    startTime: "t400",
    name: "p400",
    uses: "files",
    owner: "self",
    known: null,
    endable: true,
    protected: false,
  });
});

test("pid 1 stays protected without a process table", () => {
  const [p] = classifyProcesses(found(1), { serverPid: 100, uid: 501, identity });
  assert.equal(p.protected, true);
});

test("pane trees are session processes, Gateway children are agent commands", () => {
  const rows = [
    [1, 0],
    [200, 1], // tmux
    [210, 200], // pane of s1
    [211, 210], // dev server in s1
    [220, 200], // pane of s2
    [300, 1], // gateway
    [310, 300], // agent shell command
    [311, 310],
  ];
  const result = classifyProcesses(found(211, 220, 311, 999), {
    serverPid: 100,
    gatewayPid: 300,
    tmuxPid: 200,
    sessionPanes: [
      { id: "s1", pid: 210 },
      { id: "s2", pid: 220 },
    ],
    table: table(rows),
    uid: 501,
    identity,
  });
  const known = Object.fromEntries(result.map((p) => [p.pid, p.known]));
  assert.deepEqual(known, {
    211: { kind: "session", sessionId: "s1" },
    220: { kind: "session", sessionId: "s2" },
    311: { kind: "agent-command" },
    999: null,
  });
});

test("other users' processes are listed but not endable", () => {
  const procs = [
    { pid: 70, name: "root-thing", uid: 0, uses: "cwd" },
    { pid: 71, name: "unknown", uid: null, uses: "files" },
  ];
  const result = classifyProcesses(procs, {
    serverPid: 100,
    table: table([[70, 1]]),
    uid: 501,
    identity,
  });
  assert.equal(result.length, 2);
  for (const p of result) {
    assert.equal(p.owner, "other");
    assert.equal(p.endable, false);
    assert.equal(p.protected, false);
  }
});

test("a process that ended since the scan is dropped; one without identity is not endable", () => {
  const result = classifyProcesses(found(10, 11), {
    serverPid: 100,
    uid: 501,
    identity: (pid) => {
      throw new Error(pid === 10 ? "gone" : "no access");
    },
    alive: (pid) => pid === 11,
  });
  assert.deepEqual(
    result.map((p) => [p.pid, p.startTime, p.endable]),
    [[11, null, false]],
  );
});

test("a scan past its bound reports timeout", async () => {
  const r = await scanFolderProcesses(["/x"], {
    timeoutMs: 20,
    run: () => new Promise(() => {}),
  });
  assert.equal(r.status, "timeout");
});

test("a scan passes the lsof output through the parser", async () => {
  const calls = [];
  const r = await scanFolderProcesses(["/work/app"], {
    platform: "darwin",
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: lsofRecord(9, "vim", 501, [["cwd", "/work/app"]]) };
    },
  });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.processes, [{ pid: 9, name: "vim", uid: 501, uses: "cwd" }]);
  assert.equal(calls[0].file, "/usr/sbin/lsof");
  assert.deepEqual(calls[0].args, ["-w", "-n", "-P", "-F0pcufn"]);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("lsof exit 1 with output counts; without output the scan failed", async () => {
  const fail = (stdout) => async () => {
    throw Object.assign(new Error("exit 1"), { code: 1, stdout });
  };
  const out = lsofRecord(9, "vim", 501, [["cwd", "/work/app"]]);
  const ok = await scanFolderProcesses(["/work/app"], {
    platform: "darwin",
    run: fail(out),
  });
  assert.equal(ok.status, "ok");
  assert.equal(ok.processes.length, 1);
  const bad = await scanFolderProcesses(["/work/app"], {
    platform: "darwin",
    run: fail(""),
  });
  assert.deepEqual(bad, { status: "failed", processes: [] });
  const missing = await scanFolderProcesses(["/work/app"], {
    platform: "darwin",
    run: async () => {
      throw Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(missing.status, "failed");
});

function fakeProc(procs) {
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const eacces = () => Object.assign(new Error("EACCES"), { code: "EACCES" });
  return {
    readdir: async (dir) => {
      if (dir === "/proc") return [...Object.keys(procs), "self", "meminfo"];
      const pid = /^\/proc\/(\d+)\/fd$/.exec(dir)?.[1];
      if (!procs[pid]) throw enoent();
      if (procs[pid].denied) throw eacces();
      return Object.keys(procs[pid].fds || {});
    },
    readlink: async (link) => {
      const [, pid, kind, fd] = /^\/proc\/(\d+)\/(cwd|fd)(?:\/(\d+))?$/.exec(link) || [];
      const proc = procs[pid];
      if (!proc) throw enoent();
      if (proc.denied) throw eacces();
      return kind === "cwd" ? proc.cwd : proc.fds[fd];
    },
    stat: async (dir) => ({ uid: procs[dir.split("/")[2]].uid }),
    readFile: async (file) => `${procs[file.split("/")[2]].comm}\n`,
  };
}

test("Linux falls back to /proc when lsof is missing", async () => {
  const readProc = fakeProc({
    10: { cwd: "/work/app/src", fds: { 0: "/dev/null" }, uid: 1000, comm: "bash" },
    11: { cwd: "/home/me", fds: { 3: "/work/app/db.sqlite" }, uid: 1000, comm: "node" },
    12: { cwd: "/work/app2", fds: { 3: "/work/app2/x" }, uid: 1000, comm: "vim" },
    13: { denied: true, uid: 0, comm: "root" },
  });
  const r = await scanFolderProcesses(["/work/app"], {
    platform: "linux",
    run: async () => {
      throw Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
    },
    readProc,
  });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.processes, [
    { pid: 10, name: "bash", uid: 1000, uses: "cwd" },
    { pid: 11, name: "node", uid: 1000, uses: "files" },
  ]);
});

test("the /proc fallback stays within the same bound", async () => {
  const readProc = {
    readdir: () => new Promise(() => {}),
  };
  const r = await scanFolderProcesses(["/work/app"], {
    platform: "linux",
    timeoutMs: 20,
    run: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    readProc,
  });
  assert.equal(r.status, "timeout");
});

function fakeSignals({ startTime = "t1", exitsOn = "SIGTERM", reusedAs = null } = {}) {
  const sent = [];
  let alive = true;
  let current = startTime;
  return {
    sent,
    identity: () => {
      if (!alive) throw new Error("gone");
      return { startTime: current };
    },
    signal: (pid, sig) => {
      if (sig === 0) {
        if (!alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return true;
      }
      if (!alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      sent.push([pid, sig]);
      if (sig === exitsOn) {
        if (reusedAs) current = reusedAs;
        else alive = false;
      }
      return true;
    },
  };
}

test("endProcess sends TERM, then KILL after the grace period, never to a reused pid", async () => {
  const polite = fakeSignals();
  assert.equal(
    await endProcess({ pid: 7, startTime: "t1" }, { graceMs: 50, ...polite }),
    "ended",
  );
  assert.deepEqual(polite.sent, [[7, "SIGTERM"]]);

  const stubborn = fakeSignals({ exitsOn: "SIGKILL" });
  const started = Date.now();
  assert.equal(
    await endProcess({ pid: 7, startTime: "t1" }, { graceMs: 60, ...stubborn }),
    "ended",
  );
  assert.ok(Date.now() - started >= 55);
  assert.deepEqual(stubborn.sent, [
    [7, "SIGTERM"],
    [7, "SIGKILL"],
  ]);

  const reused = fakeSignals({ startTime: "t2" });
  assert.equal(
    await endProcess({ pid: 7, startTime: "t1" }, { graceMs: 50, ...reused }),
    "changed",
  );
  assert.deepEqual(reused.sent, []);

  // The pid was reused during the grace period: no KILL for the newcomer.
  const swapped = fakeSignals({ reusedAs: "t9" });
  assert.equal(
    await endProcess({ pid: 7, startTime: "t1" }, { graceMs: 50, ...swapped }),
    "ended",
  );
  assert.deepEqual(swapped.sent, [[7, "SIGTERM"]]);

  const gone = fakeSignals();
  gone.signal(7, "SIGTERM");
  gone.sent.length = 0;
  assert.equal(
    await endProcess({ pid: 7, startTime: "t1" }, { graceMs: 50, ...gone }),
    "gone",
  );
  assert.deepEqual(gone.sent, []);
});

test("endProcess refuses a process without a known start time", async () => {
  const fake = fakeSignals();
  assert.equal(
    await endProcess({ pid: 7, startTime: null }, { graceMs: 10, ...fake }),
    "changed",
  );
  assert.deepEqual(fake.sent, []);
});

// Real processes: only children this test spawns itself.
function tempFolder(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-folder-procs-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function spawnIn(t, cwd, script) {
  const child = spawn(process.execPath, ["-e", script], { cwd, stdio: "ignore" });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return child;
}

test("finds and ends a real child working in the folder", async (t) => {
  const folder = tempFolder(t);
  const child = spawnIn(
    t,
    folder,
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const scan = await scanFolderProcesses([folder]);
  assert.equal(scan.status, "ok");
  const mine = scan.processes.find((p) => p.pid === child.pid);
  assert.ok(mine, "the child is found");
  assert.equal(mine.uses, "cwd");
  const [proc] = classifyProcesses([mine], { serverPid: process.pid, table: new Map() });
  assert.equal(proc.owner, "self");
  assert.equal(proc.endable, true);
  const exited = new Promise((resolve) => child.once("exit", (_, sig) => resolve(sig)));
  assert.equal(await endProcess(proc, { graceMs: 300 }), "ended");
  assert.equal(await exited, "SIGKILL");
});
