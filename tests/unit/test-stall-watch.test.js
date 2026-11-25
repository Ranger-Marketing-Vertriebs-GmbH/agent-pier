import test from "node:test";
import assert from "node:assert/strict";
import {
  fileProcesses,
  stallReport,
  stallWatch,
} from "../../scripts/test-stall-watch.mjs";

const cwd = "/repo";
const file = "/repo/tests/a.test.js";
const whole = (type, name = "tests/a.test.js") => ({
  type,
  data: { file: `/repo/${name}`, name, nesting: 0 },
});
const inner = (type, name, at = file) => ({ type, data: { file: at, name, nesting: 0 } });

test("a file that runs a test without an end is stalled once the limit passed", () => {
  const watch = stallWatch({ limitMs: 1000, cwd });
  watch.event(whole("test:dequeue"), 0);
  watch.event(inner("test:dequeue", "first"), 100);
  watch.event(inner("test:complete", "first"), 200);
  watch.event(inner("test:dequeue", "second"), 300);
  assert.deepEqual(watch.stalled(1299), []);
  assert.deepEqual(watch.stalled(1300), [{ file, idleMs: 1000, tests: ["second"] }]);
});

test("a file whose tests all ended but which never completes is stalled too", () => {
  const watch = stallWatch({ limitMs: 1000, cwd });
  watch.event(whole("test:dequeue"), 0);
  watch.event(inner("test:dequeue", "only"), 10);
  watch.event(inner("test:complete", "only"), 20);
  // Results arrive late and in file order; they are activity all the same.
  watch.event({ type: "test:pass", data: { file, name: "only", nesting: 0 } }, 500);
  assert.deepEqual(watch.stalled(1500), [{ file, idleMs: 1000, tests: [] }]);
});

test("completed, queued and unknown files are never stalled", () => {
  const watch = stallWatch({ limitMs: 1000, cwd });
  watch.event(whole("test:enqueue", "tests/queued.test.js"), 0);
  watch.event(whole("test:dequeue"), 0);
  watch.event(whole("test:complete"), 50);
  // A result reported after its file completed does not bring the file back.
  watch.event(inner("test:pass", "late"), 60);
  watch.event({ type: "test:diagnostic", data: { message: "x" } }, 70);
  watch.event({ type: "test:stdout", data: { file, message: "x" } }, 80);
  assert.deepEqual(watch.stalled(100000), []);
});

test("touching a stalled file starts its limit again", () => {
  const watch = stallWatch({ limitMs: 1000, cwd });
  watch.event(whole("test:dequeue"), 0);
  watch.touch(file, 5000);
  assert.deepEqual(watch.stalled(5999), []);
  assert.equal(watch.stalled(6000).length, 1);
});

test("a file's processes are the runner's child that runs it and all below", () => {
  const list = [
    { pid: 10, ppid: 1, elapsed: "09:00", command: "node --test tests/a.test.js" },
    { pid: 11, ppid: 10, elapsed: "08:00", command: "node --import x tests/a.test.js" },
    { pid: 12, ppid: 10, elapsed: "08:00", command: "node tests/b.test.js" },
    { pid: 13, ppid: 11, elapsed: "07:59", command: "git -C /tmp/x commit -qm base" },
    { pid: 14, ppid: 13, elapsed: "07:59", command: "gpg --sign" },
    { pid: 15, ppid: 12, elapsed: "00:01", command: "tmux kill-server" },
  ];
  assert.deepEqual(
    fileProcesses(list, 10, file, cwd).map((entry) => entry.pid),
    [11, 13, 14],
  );
  assert.deepEqual(fileProcesses(list, 10, "/repo/tests/c.test.js", cwd), []);
});

test("the report names the file, its open test and what it was waiting on", () => {
  const stall = { file, idleMs: 600400, tests: ["the owner opens a chat"] };
  const blocked = stallReport(
    stall,
    [{ pid: 13, ppid: 11, elapsed: "07:59", command: "git -C /tmp/x commit -qm base" }],
    cwd,
  );
  assert.match(
    blocked,
    /^STUCK TEST FILE: tests\/a\.test\.js showed no activity for 600 s/,
  );
  assert.match(blocked, /Unfinished: "the owner opens a chat"/);
  assert.match(blocked, /13 07:59 git -C \/tmp\/x commit -qm base/);
  const gone = stallReport({ ...stall, tests: [] }, [], cwd);
  assert.match(gone, /No unfinished test is known/);
  const long = `node ${"--option=value ".repeat(40)}tests/a.test.js`;
  assert.match(
    stallReport(stall, [{ pid: 11, ppid: 10, elapsed: "08:00", command: long }], cwd),
    /11 08:00 node --option=value .* \.\.\. .*tests\/a\.test\.js$/m,
  );
  assert.match(gone, /a process it started still holds its output open/);
});
