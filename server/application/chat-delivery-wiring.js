import { ChatDelivery } from "../features/chat/chat-delivery.js";
import { DeliveryAcceptance } from "../features/chat/delivery-acceptance.js";

/**
 * Chat delivery with one matcher of native acceptance events: a matching event
 * confirms its delivery (`chatDelivery.acceptance` takes the CLIs' sources).
 */
export function createChatDelivery(options) {
  const acceptance = new DeliveryAcceptance({
    onMatch: (sessionId, deliveryId, outcome) =>
      chatDelivery.accept(sessionId, deliveryId, outcome),
  });
  const chatDelivery = new ChatDelivery({ ...options, acceptance });
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
 * mod's reports. The event's time is when the server hears it.
 */
export function codexProxyAcceptance(sessionId, push, current) {
  if (push.type !== "prompt-ready" && push.type !== "prompt") return;
  const acceptance = current()?.acceptance;
  if (!acceptance) return;
  acceptance.ready(sessionId, "codex-proxy");
  if (push.type === "prompt")
    acceptance.report(sessionId, {
      kind: push.kind,
      at: Date.now(),
      imageNames: null,
      imageCount: push.imageCount,
      ...(push.reason ? { reason: push.reason } : {}),
    });
}
