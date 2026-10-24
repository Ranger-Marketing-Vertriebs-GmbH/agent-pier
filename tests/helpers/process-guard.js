import { execFileSync } from "node:child_process";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";

// Long-lived or signal-ignoring processes a test starts. Each is stopped in the
// test's t.after (SIGTERM, then SIGKILL after a grace period), and whatever is still
// registered when the test process exits, also after a failure, a timeout
// (--test-force-exit) or process.exit, is killed outright. Only a SIGKILL of the
// test process itself escapes; the runner's sweep (scripts/test-process-sweep.mjs)
// catches that.
const guarded = new Set();
let installed = false;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const signal = ({ pid, group }, name) => {
  try {
    process.kill(group ? -pid : pid, name);
  } catch {
    /* Gone already. */
  }
};

/**
 * Registers `child` (a ChildProcess or a pid). `group` kills its whole process
 * group: only for a child started `detached`, which leads its own group. A bare pid
 * stays registered until `t` ends, so pass `t` for one.
 */
export function guardProcess(t, child, { group = false, graceMs = 1000 } = {}) {
  const pid = typeof child === "number" ? child : child?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  const entry = { pid, group };
  guarded.add(entry);
  // A child that exited is never signalled again: its pid may be reused by then. A
  // group stays registered until `t` ends, as its members may outlive the leader.
  if (!group && typeof child?.once === "function") {
    if (child.exitCode !== null || child.signalCode !== null) guarded.delete(entry);
    else child.once("exit", () => guarded.delete(entry));
  }
  if (!installed) {
    installed = true;
    process.once("exit", () => {
      for (const item of guarded) signal(item, "SIGKILL");
    });
  }
  t?.after(async () => {
    if (guarded.has(entry) && (group || alive(pid))) {
      signal(entry, "SIGTERM");
      for (let waited = 0; waited < graceMs && alive(pid); waited += 50)
        await new Promise((resolve) => setTimeout(resolve, 50));
      signal(entry, "SIGKILL");
    }
    guarded.delete(entry);
  });
}

/** How many processes are registered (for the helper's own tests). */
export const guardedCount = () => guarded.size;

// OpenClaw's own worker processes (dist/**/*.worker.js), not exec commands: a
// background exec may outlive a stop on purpose (assistant-shell-abort-contract).
const openClawWorker = /[\\/]openclaw[\\/]dist[\\/]\S*\.worker\.js(\s|$)/;

/** The live OpenClaw workers below `root`, from one process table snapshot. */
function openClawWorkers(root) {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const [, pid, ppid, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/) ?? [];
      return { pid: Number(pid), ppid: Number(ppid), command: command ?? "" };
    });
  const found = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { pid, ppid } of rows)
      if (found.has(ppid) && !found.has(pid)) {
        found.add(pid);
        grew = true;
      }
  }
  return rows
    .filter((row) => row.pid !== root && found.has(row.pid))
    .filter((row) => openClawWorker.test(row.command))
    .map((row) => row.pid);
}

/**
 * Makes stopping `runtime`'s Gateway also wait for OpenClaw's worker processes: its
 * SQLite read children exit only after the Gateway, once they see the IPC disconnect,
 * and write Node's compile cache into the data directory on their way out, so an
 * immediate removal of that directory raced them (ENOTEMPTY). One still there after
 * `lingerMs` is killed. Exec commands are left alone. For a supervisor a test does
 * not construct itself (the assistant graph's); GuardedRuntimeSupervisor does this.
 */
export function guardRuntimeWorkers(runtime, { lingerMs = 10000 } = {}) {
  const terminate = runtime.terminateOwnedChild.bind(runtime);
  runtime.terminateOwnedChild = async (...args) => {
    const pid = runtime.child?.pid;
    const workers = pid && alive(pid) ? openClawWorkers(pid) : [];
    await terminate(...args);
    for (const end = Date.now() + lingerMs; Date.now() < end && workers.some(alive);)
      await new Promise((resolve) => setTimeout(resolve, 50));
    for (const worker of workers.filter(alive)) signal({ pid: worker }, "SIGKILL");
  };
  return runtime;
}

/**
 * A RuntimeSupervisor whose Gateway processes are guarded: a test that dies before
 * runtime.close() never leaves an openclaw-gateway behind for days, and a stop waits
 * for OpenClaw's worker processes (guardRuntimeWorkers).
 */
export class GuardedRuntimeSupervisor extends RuntimeSupervisor {
  constructor(options) {
    super(options);
    const spawn = this.spawn;
    this.spawn = (...args) => {
      const child = spawn(...args);
      guardProcess(null, child);
      return child;
    };
    guardRuntimeWorkers(this);
  }
}
