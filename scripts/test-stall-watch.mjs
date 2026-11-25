import path from "node:path";
import { spawnSync } from "node:child_process";

// node:test enforces its per-test timeout on the test file's own event loop, and the
// runner waits for a file's process and its output without any limit. Three stalls
// therefore never time out and hold the job until its own timeout, without a word:
// a synchronous call that does not return, an exit handler that blocks, and a
// process the file started that keeps the file's output open after it ended.
// The runner's reporter (test-failures-reporter.mjs) feeds its events to a watch,
// which names the file that showed no activity for too long, lists its processes
// and stops them, so the file fails by name and the run goes on.

const resolved = (cwd, file) => path.resolve(cwd, String(file));

/**
 * Tracks the running test files from node:test's events. A file runs from its own
 * `test:dequeue` to its own `test:complete`; both and those of its tests arrive as
 * they happen, unlike results, which wait for the files before them.
 */
export function stallWatch({ limitMs, cwd = process.cwd() }) {
  const running = new Map();
  return {
    event({ type, data }, now) {
      if (!data?.file || data.name === undefined) return;
      const file = resolved(cwd, data.file);
      const whole = data.nesting === 0 && resolved(cwd, data.name) === file;
      if (whole && type === "test:dequeue")
        running.set(file, { last: now, tests: new Map() });
      const entry = running.get(file);
      if (!entry) return;
      if (whole && type === "test:complete") return void running.delete(file);
      entry.last = now;
      const open = entry.tests.get(data.name) || 0;
      if (!whole && type === "test:dequeue") entry.tests.set(data.name, open + 1);
      if (!whole && type === "test:complete") entry.tests.set(data.name, open - 1);
    },
    /** The running files without any activity for the limit, each with its open tests. */
    stalled(now) {
      return [...running]
        .filter(([, entry]) => now - entry.last >= limitMs)
        .map(([file, entry]) => ({
          file,
          idleMs: now - entry.last,
          tests: [...entry.tests].filter(([, open]) => open > 0).map(([name]) => name),
        }));
    },
    /** Starts the file's limit again, after its processes were stopped. */
    touch(file, now) {
      const entry = running.get(file);
      if (entry) entry.last = now;
    },
  };
}

function processes() {
  const result = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,etime=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10000,
  });
  return (result.stdout || "")
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, elapsed, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      elapsed,
      command,
    }));
}

/** The runner's child that runs `file`, followed by everything below it. */
export function fileProcesses(list, runner, file, cwd = process.cwd()) {
  const own = list.find(
    (entry) =>
      entry.ppid === runner &&
      entry.command.split(" ").some((word) => resolved(cwd, word) === file),
  );
  if (!own) return [];
  const tree = [own];
  for (const parent of tree)
    tree.push(...list.filter((entry) => entry.ppid === parent.pid));
  return tree;
}

// node:test starts a file with dozens of options before its path: keep both ends.
const brief = (command) =>
  command.length > 320 ? `${command.slice(0, 120)} ... ${command.slice(-190)}` : command;

/** What the job log says about a stalled file. */
export function stallReport({ file, idleMs, tests }, tree, cwd = process.cwd()) {
  const name = path.relative(cwd, file);
  const seconds = Math.round(idleMs / 1000);
  return [
    `STUCK TEST FILE: ${name} showed no activity for ${seconds} s; the per-test timeout cannot end it.`,
    tests.length
      ? `  Unfinished: ${tests.map((test) => JSON.stringify(test)).join(", ")} (a synchronous call that does not return blocks the timeout too).`
      : "  No unfinished test is known: one blocked before its start was reported, or all ended and the file's process or output did not.",
    ...(tree.length
      ? [
          "  Stopping its processes (pid, running for, command):",
          ...tree.map(
            (entry) => `    ${entry.pid} ${entry.elapsed} ${brief(entry.command)}`,
          ),
        ]
      : [
          "  Its process is gone, so a process it started still holds its output open.",
          "  Stopping the run; the runner's sweep lists what was left behind.",
        ]),
    ...(process.env.GITHUB_ACTIONS === "true"
      ? [`::error file=${name}::${name} hung and was stopped after ${seconds} s`]
      : []),
  ].join("\n");
}

/**
 * Reports each stalled file and stops its processes, deepest first, so node:test
 * fails the file and continues. Without a process left to stop the run cannot go
 * on: the runner ends itself, which fails the run without a retry.
 */
export function stopStalled(watch, { now = Date.now(), cwd = process.cwd() } = {}) {
  const stalled = watch.stalled(now);
  if (!stalled.length) return;
  const list = processes();
  for (const stall of stalled) {
    const tree = fileProcesses(list, process.pid, stall.file, cwd);
    console.error(stallReport(stall, tree, cwd));
    for (const entry of tree.reverse())
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        /* Gone meanwhile. */
      }
    if (tree.length) watch.touch(stall.file, now);
    else process.kill(process.pid, "SIGTERM");
  }
}
