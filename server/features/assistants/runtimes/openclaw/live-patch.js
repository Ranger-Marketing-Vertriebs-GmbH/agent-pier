import { assistantProblem } from "../../assistant-validation.js";
import { settledAdmission } from "./agent-admission.js";
import { setTimeout as delay } from "node:timers/promises";

// Every live OpenClaw configuration write goes through here, so a concurrent change
// surfaces as a conflict instead of being silently overwritten. OpenClaw 2026.9.8
// rejects a stale base hash with the generic INVALID_REQUEST, so a changed hash
// after the rejection is what identifies the conflict. A Gateway still admitting
// agents in the background is never written to before it is done
// (agent-admission.js), and the writes of one client run one after the other
// (`configWrite`), so writers that waited together do not race one base hash.
// Per client: the chain of its writes, the late answers still awaited and whether
// the last wait ran out (`stuck`).
const writes = new WeakMap();

// A write still runs in the Gateway after it timed out, and OpenClaw 2026.11.3
// commits a written configuration in a reload (config.get's `configRevisionHash`,
// as written, runs ahead of `appliedConfigHash` until it is applied). A write sent
// meanwhile competes with that reload for the state database; a reload that fails
// there ("config reload failed: database is locked") keeps the plugin lifecycle lease
// for its 5 minutes, and every later write waits on it until it times out. (An
// agents.create on a slow disk sets this off by itself: the lease release meets one
// lock and is not retried, which runtime-bundle-patches.js patches in 2026.11.3.)
// So before each write the client waits until the Gateway answered its timed-out
// writes (their late answers) and applied what is written (both hashes
// equal), at most `configSettleMs` in all. A wait that runs out marks the client
// `stuck`: later writes no longer wait, so a Gateway that cannot apply anything fails
// each write within its own timeout instead of after another full wait, until it is
// seen applied again.
export const configSettleMs = 60000;
const firstPollMs = 100;
const lastPollMs = 1000;

function stateOf(client) {
  let state = writes.get(client);
  if (!state) {
    state = { chain: Promise.resolve(), unanswered: new Set(), stuck: false };
    if (client) writes.set(client, state);
  }
  return state;
}

/** Whether a config.get answer names a written configuration not yet applied. */
export const reloadPending = (answer) =>
  typeof answer?.configRevisionHash === "string" &&
  typeof answer?.appliedConfigHash === "string" &&
  answer.configRevisionHash !== answer.appliedConfigHash;

function lateAnswer(client, settleMs) {
  let settle;
  const settled = new Promise((resolve) => (settle = resolve));
  const timer = setTimeout(() => settle(), settleMs);
  timer.unref?.();
  const dropped = () => settle();
  client?.once?.("disconnected", dropped);
  settled.then(() => {
    clearTimeout(timer);
    client?.off?.("disconnected", dropped);
  });
  return { settled, settle };
}

/**
 * Waits until the Gateway behind `client` answered its timed-out writes and applied
 * its written configuration (see above). Resolves to the last config.get answer
 * (null when none was read), which a patch may build on.
 */
async function quiet(client, state, { settleMs, now, sleep, warn }) {
  const deadline = now() + (state.stuck ? 0 : settleMs);
  const runOut = () => {
    if (!state.stuck)
      warn(
        `Assistant Gateway did not apply its configuration within ${settleMs} ms; writing.`,
      );
    state.stuck = true;
  };
  if (state.unanswered.size) {
    let timer;
    const answered = await Promise.race([
      Promise.all([...state.unanswered]).then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, deadline - now()));
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (!answered) runOut();
  }
  for (let pause = firstPollMs; ; pause = Math.min(lastPollMs, pause * 2)) {
    const answer = await client.call("config.get", {}).catch(() => null);
    if (!reloadPending(answer)) {
      // Applied (or nothing to tell): a stuck Gateway has recovered.
      if (answer) state.stuck = false;
      return answer;
    }
    if (now() >= deadline) {
      runOut();
      return answer;
    }
    await sleep(Math.min(pause, Math.max(0, deadline - now())));
  }
}

/**
 * Runs `write(call, current)` after every earlier configuration write of `client`,
 * once the Gateway answered the timed-out ones and applied what is written
 * (`quiet`). `current` is the config.get answer that wait read last (or null), so a
 * patch need not read it again. `call(method, params, options)` is `client.call` for
 * the writes: one that times out is awaited by the next write.
 */
export function configWrite(
  client,
  write,
  { settleMs = configSettleMs, now = Date.now, sleep = delay, warn = console.warn } = {},
) {
  const state = stateOf(client);
  const call = (method, params, options = {}) => {
    const late = lateAnswer(client, settleMs);
    return client
      .call(method, params, { ...options, onLate: late.settle, lateMs: settleMs })
      .then(
        (answer) => {
          late.settle();
          return answer;
        },
        (error) => {
          if (error?.code === "TIMEOUT") {
            state.unanswered.add(late.settled);
            late.settled.then(() => state.unanswered.delete(late.settled));
          } else late.settle();
          throw error;
        },
      );
  };
  const run = state.chain.then(async () => {
    await settledAdmission(client);
    const current = client
      ? await quiet(client, state, { settleMs, now, sleep, warn })
      : null;
    return write(call, current);
  });
  state.chain = run.catch(() => {});
  return run;
}

// OpenClaw 2026.10 admits 30 config.patch a minute per connection and refuses the
// rest before any write (UNAVAILABLE, retryable, retryAfterMs); a draining Gateway
// refuses the same way. A refused patch is sent again only after the wait the
// Gateway asks for, never in a tight loop, within `maxWaitMs` in all. A wait the
// bound cannot cover fails at once with `configBusy` (code CONFIG_BUSY).
export const configRetryLimitMs = 60000;
// A refusal before dispatch (a Gateway draining for a restart) was already repeated
// by GatewayClient.call within its timeout (gateway-retry.js) and is passed on.
const refusedForNow = (error) =>
  error?.answered === true &&
  error.beforeDispatch !== true &&
  error.code === "UNAVAILABLE" &&
  error.retryable === true &&
  Number.isFinite(error.retryAfterMs);

export function patchConfig(
  client,
  build,
  { maxWaitMs = configRetryLimitMs, wait = delay, now = Date.now } = {},
) {
  return configWrite(client, async (call, read) => {
    const deadline = now() + maxWaitMs;
    for (let known = read; ; known = null) {
      try {
        return await patchOnce(client, build, call, known);
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

// `known`: a config.get answer just read (configWrite), else it is read here.
async function patchOnce(client, build, write, known) {
  const current = known || (await client.call("config.get", {}));
  const change = build(current.config || {}, current);
  if (!change) return null;
  try {
    await write("config.patch", {
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
