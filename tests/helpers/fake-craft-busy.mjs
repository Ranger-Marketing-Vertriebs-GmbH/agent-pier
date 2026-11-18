// The busy Craft Anything of fake-craft-mcp.mjs. While `busyFile` exists every
// tools/call waits, in order, and is answered once the file is gone, like Craft
// Anything 0.6.0 while heavy work (a check's screenshots and pixel comparisons) holds
// it. `notifications/cancelled` drops a waiting call without an answer, as 0.6.0 does
// (checked with the real binary, 2026-11-18). `callLog` gets `call <tool>` and
// `cancel <id>` lines.
import { appendFileSync, existsSync } from "node:fs";

export function busyGate({ busyFile, callLog } = {}, answer) {
  const held = [];
  const cancelled = new Set();
  const log = (line) => callLog && appendFileSync(callLog, `${line}\n`);
  const busy = () => Boolean(busyFile) && existsSync(busyFile);
  const release = () => {
    if (busy()) return setTimeout(release, 20);
    while (held.length) {
      const { id, params } = held.shift();
      if (!cancelled.delete(id)) answer(id, params);
    }
  };
  return {
    /** Logs a tools/call; true when it waits (answered later through `answer`). */
    hold(id, params) {
      log(`call ${params?.name}`);
      if (!busy() && !held.length) return false;
      held.push({ id, params });
      if (held.length === 1) setTimeout(release, 20);
      return true;
    },
    cancel(requestId) {
      log(`cancel ${requestId}`);
      if (held.some((call) => call.id === requestId)) cancelled.add(requestId);
    },
  };
}
