import { recordNativeSession } from "./native-session-binding.js";

export const id = "agentpier-reader";
// OpenCode 1.18 exposes the visible route directly to TUI plugins. Watching the
// route avoids guessing from history timestamps or background server activity.
export async function tui(api) {
  const env = { ...process.env };
  let previous;
  let warned = false;
  const update = () => {
    const route = api.route.current;
    const session = route?.name === "session" ? route.params?.sessionID : null;
    if (session === previous) return;
    try {
      recordNativeSession({ session_id: session }, env, { pid: process.pid });
      previous = session;
      warned = false;
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
  api.lifecycle.onDispose(() => clearInterval(timer));
}

export default { id, tui };
