import { deliveryMatches } from "./chat-draft.js";
import { deliveryContentMatches } from "./delivery-content.js";

/** Display evidence only. Never changes custody, resend eligibility or transport receipts. */
export function nativeDeliveryStates(items, messages, input, tool, live = true) {
  const states = new Map();
  const matches = deliveryMatches(items, messages);
  for (const item of items) {
    if (item.status !== "handed-off" || !item.observation) continue;
    const { generation, hash, providerSessionId, baseline = [] } = item.observation;
    if (
      !live ||
      !generation ||
      generation !== input?.generation ||
      (providerSessionId && providerSessionId !== input.providerSessionId) ||
      !Array.isArray(input.queue)
    )
      continue;
    // Text cannot distinguish identical pending attempts or an existing TUI queue row.
    if (
      items.filter((other) => other.observation?.hash === hash).length !== 1 ||
      baseline.includes(hash)
    )
      continue;
    const queued = input.queue.filter((value) => value === hash).length;
    const messageId = matches.get(item.id);
    const message = messages.find((row) => row.id === messageId);
    // Re-check exact content; legacy presentation matching normalizes whitespace.
    const timestamp =
      typeof message?.timestamp === "number"
        ? message.timestamp
        : Date.parse(message?.timestamp);
    const fresh =
      Number.isFinite(timestamp) &&
      Number.isFinite(item.observation.startedAt) &&
      timestamp >= item.observation.startedAt;
    const nativeMatch =
      message &&
      deliveryContentMatches(item, message, true) &&
      !item.baselineIds.includes(message.id);
    // Byte-identical reuploads have different path-based delivery hashes. One
    // native image row cannot establish which attempt the CLI accepted.
    const ambiguousImage =
      message?.imageInput &&
      items.some(
        (other) =>
          other.id !== item.id &&
          (!other.matchedMessageId || other.matchedMessageId === message.id) &&
          !other.baselineIds.includes(message.id) &&
          deliveryContentMatches(other, message, true),
      );
    if (queued === 1)
      states.set(item.id, {
        state: "nativeQueued",
        messageId: nativeMatch && fresh && !ambiguousImage ? messageId : null,
      });
    else if (
      queued === 0 &&
      fresh &&
      nativeMatch &&
      !ambiguousImage &&
      (tool !== "opencode" || message.inputConsumed === true)
    )
      states.set(item.id, { state: "nativeAccepted", messageId });
  }
  return states;
}
