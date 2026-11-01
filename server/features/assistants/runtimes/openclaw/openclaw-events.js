// How OpenClaw's Gateway frames read as the port's run events (agent-runtime.js):
// `chat` frames carry a run's reply and end (`state` delta, final, aborted, error with
// its `errorKind`), `agent` frames its live progress (`stream` lifecycle, item, …),
// and `exec.approval.requested`/`resolved` the approvals. The reply of a `chat` frame
// becomes the event's `reply`, an `agent` frame's progress its `step`.
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

const isRecord = (value) => typeof value === "object" && value !== null;

// The text of a snapshot `message`, or undefined when it carries no text at all.
function messageText(message) {
  if (!isRecord(message)) return undefined;
  if (typeof message.content === "string") return message.content;
  const blocks = Array.isArray(message.content)
    ? message.content.filter((c) => c?.type === "text" && typeof c.text === "string")
    : [];
  return blocks.length ? blocks.map((c) => c.text).join("") : undefined;
}

/**
 * The reply of a `chat` frame (agent-runtime.js `reply`). OpenClaw 2026.10.3 sends a
 * run's first frame on a connection, and any frame after a rewrite, as a snapshot
 * whose `message` holds the whole reply (`text`); later frames omit `message` and
 * their `deltaText` holds only the appended text (`delta`), or the whole text
 * instead with `replace: true`. Mirrors the Gateway client's mergeChatStreamMessage.
 */
export function openClawReply(payload) {
  return {
    text: messageText(payload?.message),
    delta: typeof payload?.deltaText === "string" ? payload.deltaText : undefined,
    replace: payload?.replace === true,
  };
}

// Tools whose `meta` is the model's title or OpenClaw's summary of a command. Other
// tools describe themselves with their raw arguments (a URL, a path, a prompt).
const titled = new Set(["exec", "process"]);
const failedStatuses = new Set(["failed", "error", "blocked", "denied", "cancelled"]);

/**
 * The activity of an `agent` frame (agent-runtime.js `step`), or null: `item` frames
 * of kind "tool" (phase start/update/end, `name`, `status`, a `meta` summary),
 * `thinking` and `assistant` deltas, `run_status` phases (`retrying` with its
 * attempt), `lifecycle` phases (an exec approval's `waiting-approval`) and
 * `compaction` (OpenClaw 2026.10.3; tests/integration/assistant-run-steps-contract).
 */
export function openClawStep(payload) {
  const data = isRecord(payload?.data) ? payload.data : {};
  switch (payload?.stream) {
    case "item":
      if (data.kind !== "tool" || typeof data.itemId !== "string") return null;
      return {
        type: "tool",
        id: data.itemId,
        name: typeof data.name === "string" ? data.name : "",
        title: titled.has(data.name) && typeof data.meta === "string" ? data.meta : null,
        phase: data.phase === "end" ? "end" : data.phase === "start" ? "start" : "update",
        failed: failedStatuses.has(data.status) || data.isError === true,
      };
    case "thinking":
      return { type: "thinking" };
    case "assistant":
      return { type: "writing" };
    case "run_status":
      return {
        type: "status",
        phase: data.phase,
        attempt: data.retryAttempt,
        of: data.maxRetries,
        reason: data.reason,
      };
    case "lifecycle":
      return { type: "lifecycle", phase: data.phase };
    case "compaction":
      return { type: "compaction", phase: data.phase };
    default:
      return null;
  }
}

/**
 * One Gateway frame as a run event: the normalized envelope (`kind`, `sessionKey`,
 * `runId`, `reason`, `reply`, `step`) with OpenClaw's own frame name (`event`) and
 * `payload` alongside.
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
    reply: frame?.event === "chat" ? openClawReply(payload) : null,
    step: frame?.event === "agent" ? openClawStep(payload) : null,
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
