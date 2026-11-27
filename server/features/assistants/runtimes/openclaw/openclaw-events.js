// How OpenClaw's Gateway frames read as the port's run events (agent-runtime.js):
// `chat` frames carry a run's reply and end (`state` delta, final, aborted, error with
// its `errorKind`), `agent` frames its live progress (`stream` lifecycle, item, …),
// `exec.approval.requested`/`resolved` the approvals and `question.requested`/
// `resolved` the questions of `ask_user`. The reply of a `chat` frame becomes the
// event's `reply`, an `agent` frame's progress its `step`.
import { openClawQuestion, openClawQuestionEnd } from "./openclaw-questions.js";

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
// The questions of `ask_user` keep OpenClaw's frame names and carry the port's
// payload instead of OpenClaw's record (openclaw-questions.js), kind "other".
const questionPayloads = {
  "question.requested": openClawQuestion,
  "question.resolved": openClawQuestionEnd,
};

// A `chat` frame that carries OpenClaw's own status line instead of the reply: after
// a model fallback it sends "↪️ Model Fallback: <provider/model> (selected …)" as a
// second `final` of the run (content blocks marked `openclawStatusNotice`). It names
// internal provider ids and is no reply and no end of the run.
const statusNotice = (payload) =>
  Array.isArray(payload?.message?.content) &&
  payload.message.content.length > 0 &&
  payload.message.content.every((block) => block?.openclawStatusNotice === true);

function kindOf(name, payload) {
  if (name === "chat")
    return statusNotice(payload) ? "progress" : chatKinds[payload?.state] || "progress";
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
// Tools whose `meta` names the one thing the call works on, and how to read it out of
// OpenClaw's phrasing (tool-display of 2026.11.6, detail mode "explain"; the forms are
// pinned by tests/integration/assistant-run-steps-contract.test.js): `for "a", "b"
// (top 5)`, `from <url> (mode markdown, max 5000 chars)`, `lines 3-9 from <path>`,
// `to <path> (120 chars)`, `in <path>`, a memory query as it is. The browser names a
// page only for the actions that open one; its other details (typed text, element
// references) are left out. Deliberately absent: `pdf`, `view_image` and
// `image_generate` (their meta carries the prompt), `apply_patch` (OpenClaw gives it
// none), MCP tools and AgentPier's own tools (free arguments).
const targets = new Map([
  ["web_search", ["query", /^for (.+?)(?: \(top \d+\))?$/]],
  ["web_fetch", ["url", /^from (\S+)/]],
  ["browser", ["url", /(https?:\/\/[^\s,]+)/]],
  [
    "read",
    ["path", /^(?:lines? \d+-\d+ from|from line \d+ in|first \d+ lines? of|from) (.+)$/],
  ],
  ["write", ["path", /^to (.+?)(?: \(\d+ chars\))?$/]],
  ["edit", ["path", /^in (.+?)(?: \(\d+ chars\))?$/]],
  ["memory_search", ["query", /^([\s\S]+)$/]],
]);

// What a tool item's `meta` says the call works on (agent-runtime.js `target`), or
// null. run-steps.js decides what of it is shown.
function targetOf(name, meta) {
  const [kind, pattern] = targets.get(name) ?? [];
  const value = typeof meta === "string" && kind ? meta.match(pattern)?.[1] : null;
  return value ? { kind, value } : null;
}
const failedStatuses = new Set(["failed", "error", "blocked", "denied", "cancelled"]);
// A model ref as its model id alone: without the provider (AgentPier's are opaque
// ids, `ap-<connection>-<uuid>`) and without an account pin (`@profile`).
function modelIdOf(ref) {
  if (typeof ref !== "string" || !ref.includes("/")) return "";
  return ref.slice(ref.indexOf("/") + 1).split("@")[0];
}

/**
 * The activity of an `agent` frame (agent-runtime.js `step`), or null: `item` frames
 * of kind "tool" (phase start/update/end, `name`, `status`, a `meta` summary),
 * `thinking` and `assistant` deltas, `run_status` phases (`retrying` with its
 * attempt), `lifecycle` phases (an exec approval's `waiting-approval`) and
 * `compaction` (OpenClaw 2026.10.3; tests/integration/assistant-run-steps-contract).
 * A lifecycle `fallback_step` (2026.11.6: the run moves on to a fallback model,
 * tests/integration/assistant-model-fallback-contract) is the step "fallback" with
 * the model id it moves to; `failed` once the whole chain is exhausted.
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
        target: targetOf(data.name, data.meta),
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
      if (data.phase === "fallback_step")
        return {
          type: "fallback",
          model: modelIdOf(data.fallbackStepToModel),
          failed: data.fallbackStepFinalOutcome === "chain_exhausted",
        };
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
  const question = questionPayloads[frame?.event];
  const payload = question ? question(frame.payload) : frame?.payload;
  const kind = kindOf(frame?.event, payload);
  return {
    kind,
    sessionKey: payload?.sessionKey ?? null,
    runId: payload?.runId ?? null,
    reason: kind === "failed" ? (payload?.errorKind ?? null) : null,
    reply:
      frame?.event === "chat" && !statusNotice(payload) ? openClawReply(payload) : null,
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
