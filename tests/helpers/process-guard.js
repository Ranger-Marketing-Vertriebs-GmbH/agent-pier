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

/**
 * A RuntimeSupervisor whose Gateway processes are guarded: a test that dies before
 * runtime.close() never leaves an openclaw-gateway behind for days.
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
  }
}
