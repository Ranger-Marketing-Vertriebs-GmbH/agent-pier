// What a drag into a split view carries, under a MIME type private to AgentPier so
// OS file drops and the explorer's own drags (application/x-agentpier-files) never
// look like one. Payloads: `{ item }` (a session row), `{ agent: { assistantId } }`
// (an agent row, resolved to its chat on drop) and `{ pane: { viewId, key } }` (a
// pane header). Browsers hide drag data until the drop, so the payload of a drag
// that started here is also kept until it ends, for drop zones to decide while
// hovering.
export const PANE_MIME = "application/x-agentpier-pane";

const isText = (value) => typeof value === "string" && value.length > 0;
const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function cleanItem(item) {
  if (!isRecord(item)) return null;
  if (item.kind === "session" && isText(item.id)) return { kind: "session", id: item.id };
  if (item.kind === "chat" && isText(item.assistantId) && isText(item.conversationId))
    return {
      kind: "chat",
      assistantId: item.assistantId,
      conversationId: item.conversationId,
    };
  return null;
}

/** The payload in its known shape, or null. */
export function cleanPayload(value) {
  if (!isRecord(value)) return null;
  if (value.item !== undefined) {
    const item = cleanItem(value.item);
    return item ? { item } : null;
  }
  if (isRecord(value.agent) && isText(value.agent.assistantId))
    return { agent: { assistantId: value.agent.assistantId } };
  if (isRecord(value.pane) && isText(value.pane.viewId) && isText(value.pane.key))
    return { pane: { viewId: value.pane.viewId, key: value.pane.key } };
  return null;
}

let current = null;
const clear = () => {
  current = null;
};

/** Starts a drag of `payload` (call from `dragstart`). */
export function writePayload(dataTransfer, payload) {
  dataTransfer.setData(PANE_MIME, JSON.stringify(payload));
  dataTransfer.effectAllowed = "move";
  current = cleanPayload(payload);
  if (typeof window !== "undefined")
    window.addEventListener("dragend", clear, { once: true, capture: true });
}

/** The payload of a drop; null when there is none or it is malformed. */
export function readPayload(dataTransfer) {
  let raw = "";
  try {
    raw = dataTransfer?.getData(PANE_MIME) ?? "";
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return cleanPayload(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The payload under a drag while it hovers (the data itself is hidden until the drop). */
export const draggedPayload = (dataTransfer) => readPayload(dataTransfer) ?? current;

export const hasPayload = (types) => Array.from(types ?? []).includes(PANE_MIME);
