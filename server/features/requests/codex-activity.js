// Derive one session activity from the app-server's thread and turn notifications.
// A session can run several threads (sub-agents); any waiting thread wins, then any
// working one.
// Codex's error code for a turn that hit the account's usage limit (app-server
// camelCase, rollout snake_case).
const usageLimitCodes = new Set(["usageLimitExceeded", "usage_limit_exceeded"]);

/** A failed turn's usage limit, with Codex's own message (it names the reset time). */
export function codexTurnLimit(params) {
  const error = params?.turn?.error;
  const code = error?.codexErrorInfo ?? error?.codex_error_info;
  if (!usageLimitCodes.has(code)) return null;
  return {
    failure: "usage-limit",
    ...(typeof error.message === "string" ? { detail: error.message.slice(0, 500) } : {}),
  };
}

export function codexActivityTracker(report = () => {}, now = Date.now) {
  const threads = new Map();
  let current = null;
  const set = (threadId, state) => {
    if (typeof threadId !== "string" || !threadId) return;
    if (state === "idle") threads.delete(threadId);
    else if (threads.has(threadId) || threads.size < 256) threads.set(threadId, state);
  };
  return function observe(message) {
    const params = message?.params;
    const event = message?.method;
    if (event === "turn/started") {
      if (threads.get(params?.threadId) !== "waiting") set(params?.threadId, "working");
    } else if (event === "turn/completed") set(params?.threadId, "idle");
    else if (event === "thread/status/changed") {
      const status = params?.status;
      if (status?.type === "active")
        set(
          params.threadId,
          (status.activeFlags || []).some((flag) => /^waitingOn/.test(flag))
            ? "waiting"
            : "working",
        );
      else set(params?.threadId, "idle");
    } else if (["thread/closed", "thread/deleted", "thread/archived"].includes(event))
      set(params?.threadId, "idle");
    else return;
    const states = [...threads.values()];
    const state = states.includes("waiting")
      ? "waiting"
      : states.includes("working")
        ? "working"
        : "idle";
    const limit = event === "turn/completed" ? codexTurnLimit(params) : null;
    if (state === current && !limit) return;
    current = state;
    const reported = ["thread/closed", "thread/deleted", "thread/archived"].includes(
      event,
    )
      ? "thread/status/changed"
      : event;
    try {
      report({ state, event: reported, at: now(), ...limit });
    } catch {
      /* Activity is advisory; the native protocol never waits for it. */
    }
  };
}
