// How the chat presents the server's delivery confirmation (docs/architecture.md):
// an event- or screen-confirmed handoff becomes `accepted`, a hook block `rejected`.

/** An unconfirmed event-based handoff turns into a question after this long. */
export const ASK_AFTER_MS = 8000;
/** How long an accepted local command shows "handed over" before it hides. */
export const COMMAND_NOTICE_MS = 3000;

/** Statuses of a finished handoff: the message reached the CLI. */
export const delivered = (status) => ["handed-off", "accepted"].includes(status);

/** A rejection the CLI's hook made after the handoff. */
export const hookBlocked = (receipt) =>
  receipt.status === "rejected" &&
  ["CHAT_HOOK_BLOCKED", "CHAT_HOOK_BLOCKED_DRAFT"].includes(receipt.reason);

/**
 * Whether `receipt` of the same attempt may replace an item in status `from`.
 * A handoff may still be accepted or blocked by a hook; nothing else is undone.
 */
export const receiptAdvances = (from, receipt) =>
  from === receipt.status ||
  !["handed-off", "rejected", "accepted"].includes(from) ||
  (from === "handed-off" && (receipt.status === "accepted" || hookBlocked(receipt)));

/** A handoff the server still confirms from CLI events or the screen. */
export const awaitsConfirmation = (item) =>
  item.status === "handed-off" && ["events", "screen"].includes(item.confirmation);

/** The confirmation fields of a server receipt, copied onto the chat's item. */
export const confirmationFields = (receipt) => ({
  confirmation: receipt.confirmation,
  command: receipt.command === true || undefined,
  submittedAt: receipt.submittedAt,
  acceptedAt: receipt.acceptedAt,
  hookReason: receipt.status === "rejected" ? receipt.hookReason : undefined,
});

/** Keeps the last 20 finished handoffs; everything else stays until resolved. */
export const retainRecent = (items) => {
  const completed = items.filter((item) => delivered(item.status)).slice(-20);
  return items.filter((item) => !delivered(item.status) || completed.includes(item));
};

// Server and browser clocks may differ: never count less than nothing.
const elapsed = (since, now) =>
  Number.isFinite(since) ? Math.max(0, now - since) : null;

/**
 * The confirmation view of `item` at browser time `now`, or null for today's
 * presentation (text-confirmed and older receipts). Shown views are chatDeliveryCopy
 * keys; "accepted" shows no notice. The views:
 * "commandHandedOff", "hidden", "handed-off", "askCheck", "hookBlocked" or
 * "hookBlockedDraft".
 */
export function deliveryView(item, now) {
  if (item.status === "accepted") {
    if (!item.command) return "accepted";
    const since = elapsed(item.acceptedAt, now);
    return since !== null && since < COMMAND_NOTICE_MS ? "commandHandedOff" : "hidden";
  }
  if (item.status === "rejected" && item.reason === "CHAT_HOOK_BLOCKED")
    return "hookBlocked";
  if (item.status === "rejected" && item.reason === "CHAT_HOOK_BLOCKED_DRAFT")
    return "hookBlockedDraft";
  if (awaitsConfirmation(item)) {
    const since = elapsed(item.submittedAt, now);
    return since !== null && since < ASK_AFTER_MS ? "handed-off" : "askCheck";
  }
  return null;
}

/** Milliseconds until the view of one of `items` changes by time alone, or null. */
export function nextDeliveryChange(items, now) {
  const waits = items.flatMap((item) => {
    const view = deliveryView(item, now);
    if (view === "handed-off") return [ASK_AFTER_MS - elapsed(item.submittedAt, now)];
    if (view === "commandHandedOff")
      return [COMMAND_NOTICE_MS - elapsed(item.acceptedAt, now)];
    return [];
  });
  return waits.length ? Math.min(...waits) : null;
}
