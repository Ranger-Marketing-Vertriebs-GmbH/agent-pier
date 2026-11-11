// Loaded by OpenCode's own runtime, in a sandbox too: only modules that import no
// package by a bare name (native-session-receipt.js says why).
import { claimNativeSession, recordNativeSession } from "./native-session-receipt.js";
import definition from "../clis/opencode/definition.js";
import { idOptional } from "../clis/opencode/binding.js";
import { recordNativeActivity } from "./native-session-activity.js";
import { NativeRequestChannel } from "../requests/native-channel.js";
import { streamOpenCodeReplies } from "./opencode-reply-stream.js";

export const id = "agentpier-reader";
// OpenCode 1.18 exposes the visible route directly to TUI plugins. Watching the
// route avoids guessing from history timestamps or background server activity.
/** The visible session's busy state as AgentPier's activity, or null when unknown. */
export function openCodeActivity(api, session) {
  const state = api.state?.session;
  if (!session || typeof state?.status !== "function") return null;
  const waiting = ["permission", "question"].some(
    (kind) => typeof state[kind] === "function" && (state[kind](session) || []).length,
  );
  if (waiting) return "waiting";
  const type = state.status(session)?.type;
  return type === "busy" || type === "retry" ? "working" : "idle";
}
/** The session's broker channel for push hints, or null without one. */
export function pushChannel(
  env,
  create = (options) => new NativeRequestChannel(options),
) {
  if (!env.AGENTPIER_REQUEST_FILE) return null;
  try {
    return create({ env });
  } catch {
    return null;
  }
}
/** The TUI plugin; tests inject the channel factory. */
export const readerTui = ({
  channel: open = pushChannel,
  env: base = process.env,
  ps,
} = {}) =>
  async function tui(api) {
    const env = { ...base };
    const channel = open(env);
    const visible = () => {
      const route = api.route?.current;
      return route?.name === "session" ? route.params?.sessionID : null;
    };
    const stopReplies = channel ? streamOpenCodeReplies(api, channel, visible) : () => {};
    let previous;
    let reported;
    let warned = false;
    let claimAfter = 0;
    const activity = (session) => {
      let state;
      try {
        state = openCodeActivity(api, session);
      } catch {
        state = null;
      }
      if (!state || state === reported) return;
      try {
        recordNativeActivity({ state, event: "session.status" }, env);
        reported = state;
        channel?.activity("session.status");
      } catch {
        /* The terminal reading stays the fallback. */
      }
    };
    const update = () => {
      const route = api.route.current;
      const session = route?.name === "session" ? route.params?.sessionID : null;
      activity(session);
      if (session === previous) return;
      try {
        recordNativeSession({ session_id: session }, env, {
          pid: process.pid,
          ps,
          // This plugin reports before OpenCode names its session.
          idOptional: (tool) => tool === definition.id && idOptional,
        });
        previous = session;
        warned = false;
        channel?.activity();
      } catch (error) {
        // A sandbox denies the process list: the server writes the receipt. One
        // claim at a time, and a refused one is not repeated every tick.
        if (error.processUnreadable) {
          if (Date.now() < claimAfter) return;
          claimAfter = Date.now() + 5000;
          claimNativeSession({ session_id: session }, env)
            .then((bound) => {
              if (!bound || visible() !== session) return;
              previous = session;
              channel?.activity();
            })
            .catch(() => {});
          return;
        }
        if (!warned) {
          process.stderr.write(
            `agentpier-reader: ${String(error.message).slice(0, 240)}\n`,
          );
          warned = true;
        }
      }
    };
    update();
    const timer = setInterval(update, 250);
    timer.unref?.();
    api.lifecycle.onDispose(() => {
      clearInterval(timer);
      stopReplies();
      channel?.close();
    });
  };

export const tui = readerTui();
export default { id, tui };
