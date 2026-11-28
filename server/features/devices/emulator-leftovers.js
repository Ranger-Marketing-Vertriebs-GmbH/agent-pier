import fs from "node:fs";
import path from "node:path";
import { processIdentity } from "../../lib/process-identity.js";
import { ownProcess, within } from "./adb-client.js";
import { isDeviceId } from "./avd-files.js";

/*
 * The emulators an earlier AgentPier process left running, found by the run records
 * the emulator source keeps (`run/<id>.json`: `{ pid, startTime, consolePort,
 * adbPort }`). A process is signalled only when it is alive, has the recorded start
 * time and runs an executable below the SDK; any other pid, one the system gave to
 * another program included, is left alone and only its record is removed.
 */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// Ends the process `stored` names when it is ours. Resolves whether it was.
async function end(stored, { sdk, identity, graceMs }) {
  const own = () => ownProcess(stored, sdk, identity);
  if (!own()) return false;
  const signal = (name) => {
    try {
      process.kill(-stored.pid, name);
    } catch {
      try {
        process.kill(stored.pid, name);
      } catch {
        // Gone meanwhile.
      }
    }
  };
  signal("SIGTERM");
  if (!(await within(graceMs, () => !alive(stored.pid))) && own()) signal("SIGKILL");
  await within(graceMs, () => !alive(stored.pid));
  return true;
}

/**
 * Stops the leftover emulators of the run folder `run` and removes their records;
 * `sdk` is the SDK folder, `graceMs` the time from SIGTERM to SIGKILL, and `live(id)`
 * says that this process runs device `id` itself (its record is not a leftover).
 * Only the record that was read is removed: while the old process ends, a start may
 * have written its own. Resolves the ids whose process was stopped.
 */
export async function reclaimLeftovers({
  run,
  sdk,
  graceMs,
  live,
  identity = processIdentity,
}) {
  let names = [];
  try {
    names = fs.readdirSync(run);
  } catch {
    // No run folder: nothing was ever started.
  }
  const stopped = [];
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : null;
    if (!isDeviceId(id) || live(id)) continue;
    const file = path.join(run, name);
    const read = () => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    };
    const text = read();
    let stored = null;
    try {
      stored = JSON.parse(text);
    } catch {
      // A damaged record names nothing.
    }
    if (stored && (await end(stored, { sdk, identity, graceMs }))) stopped.push(id);
    if (!live(id) && read() === text) fs.rmSync(file, { force: true });
  }
  return stopped;
}
