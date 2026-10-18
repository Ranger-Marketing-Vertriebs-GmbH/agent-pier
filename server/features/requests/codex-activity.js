// Derive one session activity from the app-server's thread and turn notifications.
// A session can run several threads (sub-agents); any waiting thread wins, then any
// working one.
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
    if (state === current) return;
    current = state;
    const reported = ["thread/closed", "thread/deleted", "thread/archived"].includes(
      event,
    )
      ? "thread/status/changed"
      : event;
    try {
      report({ state, event: reported, at: now() });
    } catch {
      /* Activity is advisory; the native protocol never waits for it. */
    }
  };
}
