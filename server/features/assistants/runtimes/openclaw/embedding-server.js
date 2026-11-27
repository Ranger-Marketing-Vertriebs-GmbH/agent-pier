import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentity } from "../../../../lib/process-identity.js";

// The llama.cpp server for memory embeddings is a child of the Gateway (or of an
// offline `openclaw memory index`), which stops it when it ends. A Gateway that was
// killed (SIGKILL after its drain, a crash) leaves the server and its loaded model
// behind, and OpenClaw reclaims such an orphan only for an installation it manages
// itself. The server's start wrapper writes its pid (openclaw-config/
// semantic-memory.js); AgentPier stops what is left before every Gateway start and at
// its own shutdown.

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/** Whether process `pid` runs the executable `command` (by its real path). */
function runs(pid, command, identity) {
  try {
    const expected = realpath(command);
    return !!expected && identity(pid).executable === expected;
  } catch {
    return false;
  }
}

async function gone(pid, timeoutMs) {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (!alive(pid)) return true;
    await delay(50);
  }
  return !alive(pid);
}

/**
 * Stops the embedding server whose pid `pidFile` names, if that process still runs
 * the server executable `command`: SIGTERM, then SIGKILL after `graceMs`. A pid that
 * is gone, or that now belongs to another program, is left alone. The pid file is
 * removed either way. Never throws.
 */
export async function reclaimEmbeddingServer(
  { pidFile, command },
  { identity = processIdentity, graceMs = 5000 } = {},
) {
  let pid;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return false;
  }
  let stopped = false;
  try {
    if (
      Number.isSafeInteger(pid) &&
      pid > 1 &&
      alive(pid) &&
      runs(pid, command, identity)
    ) {
      process.kill(pid, "SIGTERM");
      if (!(await gone(pid, graceMs)) && runs(pid, command, identity))
        process.kill(pid, "SIGKILL");
      stopped = true;
    }
  } catch {
    /* Gone meanwhile, or not ours to signal. */
  }
  fs.rmSync(pidFile, { force: true });
  return stopped;
}
