import test from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../../server/application/project-deletion-preflight.js";
import { classifyProcesses } from "../../server/features/projects/folder-processes.js";
import { preflightFixture } from "../helpers/project-deletion-preflight-fixture.js";

const noGit = async () => ({
  status: "none",
  worktrees: [],
  unpushedBranches: null,
  worktreesChecked: true,
});

// tmux 200 with the panes of the project's own Codex session (s1, twelve processes
// in its tree) and of a session of another project (s2), plus an editor of the owner.
const uid = process.getuid();
const rows = [
  [1, 0],
  [200, 1],
  [210, 200],
  ...Array.from({ length: 12 }, (_, i) => [211 + i, 210]),
  [230, 200],
  [231, 230],
  [900, 1],
];
const table = new Map(rows.map(([pid, ppid]) => [pid, { pid, ppid }]));
const using = (pid) => ({ pid, name: `p${pid}`, uid, uses: "cwd" });
const identity = (pid) => ({ startTime: `t${pid}`, executable: `/bin/p${pid}` });
const classify = (found, context) => classifyProcesses(found, { ...context, identity });

function fixture(t) {
  const f = preflightFixture(t);
  f.row("p1", f.app);
  f.session("s1", { cwd: f.app }, { status: "running" });
  const context = async () => ({
    table,
    sessionPanes: [
      { id: "s1", pid: 210, name: "Session s1" },
      { id: "s2", pid: 230, name: "Other project" },
    ],
    tmuxPid: 200,
    gatewayPid: null,
  });
  const run = (found) =>
    preflight(f.services, f.app, {
      git: noGit,
      scan: async () => ({ status: "ok", processes: found }),
      processContext: context,
      classify,
    });
  return run;
}

test("the project's own session processes are not offered as other processes", async (t) => {
  const run = fixture(t);
  const ownTree = rows.filter(([, ppid]) => ppid === 210).map(([pid]) => using(pid));
  const report = await run([using(210), ...ownTree, using(900)]);
  // The session blocks once, under its name, and "Stop sessions" ends it whole.
  assert.deepEqual(
    report.blockers.sessions.map((s) => s.id),
    ["s1"],
  );
  assert.deepEqual(
    report.processes.list.map((item) => item.pid),
    [900],
  );
  assert.equal(report.processes.list[0].endable, true);
  assert.equal(report.ready, false);
});

test("a session of another project in the folder blocks as that session", async (t) => {
  const run = fixture(t);
  const report = await run([using(231)]);
  assert.deepEqual(
    report.blockers.sessions.map(({ id, name }) => ({ id, name })),
    [
      { id: "s1", name: "Session s1" },
      { id: "s2", name: "Other project" },
    ],
  );
  assert.deepEqual(report.processes.list, []);
  assert.equal(report.ready, false);
});

test("a session's processes are never endable one by one", () => {
  const [inSession, editor] = classifyProcesses([using(211), using(900)], {
    serverPid: 100,
    tmuxPid: 200,
    sessionPanes: [{ id: "s1", pid: 210, name: "Codex" }],
    table,
    uid,
    identity,
  });
  assert.deepEqual(inSession.known, { kind: "session", sessionId: "s1", name: "Codex" });
  assert.equal(inSession.endable, false);
  assert.equal(editor.endable, true);
});
