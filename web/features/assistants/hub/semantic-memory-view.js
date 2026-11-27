import { assistantSemanticMemoryCopy as copy } from "../../../lib/i18n/messages/assistant-semantic-memory.js";

// What the Runtime tab shows of the owner's semantic memory search
// (GET /api/assistant-semantic-memory, the live topic `runtime.semantic-memory`).

const tones = {
  off: "idle",
  on: "ok",
  downloading: "working",
  rebuilding: "working",
  failed: "error",
};

/** Whether `status` is a status this build can show. */
export const validSemanticMemory = (status) =>
  !!status &&
  Object.hasOwn(tones, status.state) &&
  typeof status.enabled === "boolean" &&
  Number.isInteger(status.revision);

/** The text of a refusal or failure `code`, a known one in words. */
const reasonText = (texts, code) =>
  Object.hasOwn(texts, code) ? texts[code] : copy.failed(code);

/**
 * The view of `status`: `{ tone, state, running, progress, note, alert, action }`.
 * `progress` is the running step in words (`bytes(n)` formats a size); `note` a
 * plain remark, `alert` why it is off after a failure; `action` the switch the owner
 * may use now, `{ kind: "on" | "off", label, hint, disabled }`.
 */
export function semanticMemoryView(status, bytes) {
  const running = ["downloading", "rebuilding"].includes(status.state);
  const { progress } = status;
  let step = "";
  if (status.state === "downloading")
    step = copy.downloading(bytes(progress?.received || 0), bytes(progress?.total || 0));
  else if (status.state === "rebuilding")
    step =
      progress?.phase === "indexing" || !Object.hasOwn(copy.phases, progress?.phase)
        ? copy.indexing(progress?.done || 0, progress?.total || 0)
        : copy.phases[progress.phase];
  const kind = status.enabled ? "off" : "on";
  // Switching off never needs the embeddings; switching on needs them usable.
  const blocked = kind === "on" && status.available === false ? status.reason : "";
  return {
    tone: tones[status.state],
    state: copy.states[status.state],
    running,
    progress: step,
    note: status.pending ? copy.pending : "",
    alert:
      status.state === "failed" && status.failure?.code
        ? reasonText(copy.failures, status.failure.code)
        : "",
    action: {
      kind,
      label: kind === "on" ? copy.turnOn : copy.turnOff,
      hint: blocked
        ? reasonText(copy.unavailable, blocked)
        : kind === "on"
          ? copy.turnOnHint
          : copy.turnOffHint,
      disabled: running || !!blocked,
    },
  };
}

/** The message of a refused switch (`error.code` of the PUT), in words. */
export function switchRefusal(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (Object.hasOwn(copy.errors, code)) return copy.errors[code];
  const reason = code.replace(/^SEMANTIC_MEMORY_/, "");
  if (Object.hasOwn(copy.unavailable, reason)) return copy.unavailable[reason];
  return code ? copy.failed(reason) : error?.message || "";
}
