import { assistantProblem } from "../assistant-validation.js";
import { settledAdmission } from "../agent-admission.js";
import { setTimeout as delay } from "node:timers/promises";

// Every live OpenClaw configuration write goes through here, so a concurrent change
// surfaces as a conflict instead of being silently overwritten. OpenClaw 2026.9.8
// rejects a stale base hash with the generic INVALID_REQUEST, so a changed hash
// after the rejection is what identifies the conflict. A Gateway still admitting
// agents in the background is never written to before it is done
// (agent-admission.js), and the writes of one client run one after the other
// (`configWrite`), so writers that waited together do not race one base hash.
const writes = new WeakMap();

/** Runs `write` after every earlier configuration write of `client`. */
export function configWrite(client, write) {
  const run = (writes.get(client) || Promise.resolve()).then(async () => {
    await settledAdmission(client);
    return write();
  });
  if (client)
    writes.set(
      client,
      run.catch(() => {}),
    );
  return run;
}

// OpenClaw 2026.10 admits 30 config.patch a minute per connection and refuses the
// rest before any write (UNAVAILABLE, retryable, retryAfterMs); a draining Gateway
// refuses the same way. A refused patch is sent again only after the wait the
// Gateway asks for, never in a tight loop, within `maxWaitMs` in all. A wait the
// bound cannot cover fails at once with `configBusy` (code CONFIG_BUSY).
export const configRetryLimitMs = 60000;
const refusedForNow = (error) =>
  error?.answered === true &&
  error.code === "UNAVAILABLE" &&
  error.retryable === true &&
  Number.isFinite(error.retryAfterMs);

export function patchConfig(
  client,
  build,
  { maxWaitMs = configRetryLimitMs, wait = delay, now = Date.now } = {},
) {
  return configWrite(client, async () => {
    const deadline = now() + maxWaitMs;
    for (;;) {
      try {
        return await patchOnce(client, build);
      } catch (error) {
        if (!refusedForNow(error)) throw error;
        // At least a moment, so a zero answer at a window's edge is no busy loop.
        const pause = Math.max(error.retryAfterMs, 250);
        if (now() + pause > deadline)
          throw Object.assign(assistantProblem("configBusy", 503), {
            code: "CONFIG_BUSY",
            retryAfterMs: error.retryAfterMs,
          });
        await wait(pause);
      }
    }
  });
}

async function patchOnce(client, build) {
  const current = await client.call("config.get", {});
  const change = build(current.config || {});
  if (!change) return null;
  try {
    await client.call("config.patch", {
      baseHash: current.hash,
      raw: JSON.stringify(change.patch),
      ...(change.replacePaths ? { replacePaths: change.replacePaths } : {}),
    });
  } catch (error) {
    if (error.answered && error.code === "INVALID_REQUEST") {
      // An INVALID_REQUEST racing a concurrent write is reported as 409; a retry
      // surfaces the real error.
      const latest = await client.call("config.get", {}).catch(() => null);
      if (latest && latest.hash !== current.hash) throw assistantProblem("conflict", 409);
    }
    throw error;
  }
  return current;
}
