import { recordNativeSession } from "./native-session-binding.js";
import { recordNativeActivity } from "./native-session-activity.js";
import { NativeRequestChannel } from "../requests/native-channel.js";

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
} = {}) =>
  async function tui(api) {
    const env = { ...base };
    const channel = open(env);
    let previous;
    let reported;
    let warned = false;
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
        recordNativeSession({ session_id: session }, env, { pid: process.pid });
        previous = session;
        warned = false;
        channel?.activity();
      } catch (error) {
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
      channel?.close();
    });
  };

export const tui = readerTui();
export default { id, tui };
