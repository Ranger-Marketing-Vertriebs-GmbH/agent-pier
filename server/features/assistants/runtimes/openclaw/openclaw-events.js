// How OpenClaw's Gateway frames read as the port's run events (agent-runtime.js):
// `chat` frames carry a run's reply and end (`state` delta, final, aborted, error with
// its `errorKind`), `agent` frames its live progress (`stream` lifecycle, item, …;
// run-steps.js reads them), and `exec.approval.requested`/`resolved` the approvals.
const chatKinds = {
  delta: "text",
  final: "finished",
  aborted: "aborted",
  error: "failed",
};
const approvalKinds = {
  "exec.approval.requested": "approval.requested",
  "exec.approval.resolved": "approval.resolved",
};

function kindOf(name, payload) {
  if (name === "chat") return chatKinds[payload?.state] || "progress";
  if (name === "agent") {
    if (payload?.stream === "lifecycle" && payload.data?.phase === "start")
      return "started";
    if (payload?.stream === "item" && payload.data?.kind === "tool") return "tool";
    return "progress";
  }
  return approvalKinds[name] || "other";
}

/**
 * One Gateway frame as a run event: the normalized envelope (`kind`, `sessionKey`,
 * `runId`, `reason`) with OpenClaw's own frame name (`event`) and `payload` alongside.
 * `sessionKey` is the payload's own: an approval names its session under
 * `request.sessionKey` and, when live, at the top level too.
 */
export function openClawRunEvent(frame) {
  const payload = frame?.payload;
  const kind = kindOf(frame?.event, payload);
  return {
    kind,
    sessionKey: payload?.sessionKey ?? null,
    runId: payload?.runId ?? null,
    reason: kind === "failed" ? (payload?.errorKind ?? null) : null,
    event: frame?.event,
    payload,
  };
}

/**
 * The events sub-port: listens on the supervisor's current client. A subscription
 * belongs to one connection, as OpenClaw sends a frame only once: after the host
 * became ready again (a restart or reconnect) callers subscribe anew.
 */
export function openClawEvents(supervisor) {
  return {
    subscribe(listener) {
      const client = supervisor.client;
      if (!client) return () => {};
      return client.subscribe((frame) => listener(openClawRunEvent(frame)));
    },
  };
}
