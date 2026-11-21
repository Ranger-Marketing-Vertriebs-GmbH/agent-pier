import { ChatDelivery } from "../features/chat/chat-delivery.js";
import { DeliveryAcceptance } from "../features/chat/delivery-acceptance.js";

/**
 * Chat delivery with one matcher of native acceptance events: a matching event
 * confirms its delivery (`chatDelivery.acceptance` takes the CLIs' sources).
 */
export function createChatDelivery({ notes, ...options }) {
  const acceptance = new DeliveryAcceptance({
    onMatch: (sessionId, deliveryId, outcome) =>
      chatDelivery.accept(sessionId, deliveryId, outcome),
  });
  const chatDelivery = new ChatDelivery({
    ...options,
    acceptance,
    // The stop notes a message carries (task-control.js).
    filterNotes: (id, ids, text) => notes?.notesCarried(id, ids, text),
    onNotesDelivered: (id, ids) => notes?.consumeNotes(id, ids),
  });
  return chatDelivery;
}

/**
 * The bridge mod's prompt reports (ClaudeModBridge options), routed to the matcher of
 * the chat delivery `current()` returns: it is created after the bridge (a report
 * before then throws, which the bridge ignores).
 */
export function claudeModAcceptance(current) {
  const acceptance = () => current()?.acceptance;
  return {
    onReady: (sessionId) => acceptance()?.ready(sessionId, "claude-mod"),
    onPrompt: (sessionId, event) => acceptance()?.report(sessionId, event),
    onForget: (sessionId) => acceptance()?.forget(sessionId),
  };
}

/**
 * The Codex proxy's prompt pushes (`prompt-ready`, `prompt`), routed like the bridge
 * mod's reports. The event's time is when the server hears it. Advisory: it never
 * throws, so the rest of the push's handling runs (a push before the chat delivery
 * exists, or a failing matcher, leaves the delivery to its timeout).
 */
export function codexProxyAcceptance(sessionId, push, current) {
  if (push.type !== "prompt-ready" && push.type !== "prompt") return;
  try {
    const acceptance = current()?.acceptance;
    if (!acceptance) return;
    acceptance.ready(sessionId, "codex-proxy");
    if (push.type === "prompt")
      acceptance.report(sessionId, {
        kind: push.kind,
        at: Date.now(),
        imageNames: null,
        imageCount: push.imageCount,
        ...(push.textHash ? { textHash: push.textHash } : {}),
        ...(push.reason ? { reason: push.reason } : {}),
      });
  } catch {
    /* The delivery falls back to its timeout. */
  }
}
