// How the chat presents the server's delivery confirmation (docs/architecture.md):
// an event- or screen-confirmed handoff becomes `accepted`, a hook block `rejected`.

/** An unconfirmed event-based handoff turns into a question after this long. */
export const ASK_AFTER_MS = 8000;
/** How long an accepted local command shows "handed over" before the notice hides. */
export const COMMAND_NOTICE_MS = 3000;
/** How long after the ask a live change still re-reads an unconfirmed handoff. */
export const REREAD_AFTER_ASK_MS = 60000;

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

/**
 * The confirmation fields of a server `receipt` for chat item `item`. The ask is
 * timed from `handedOffAt`, this browser's own time when the handoff first
 * arrived, never from the server clock. `heldInCli` marks a hook-blocked
 * message whose text is in the composer (it was the outbox) and still in the
 * CLI prompt: sending is held until the server releases it.
 */
export const confirmationFields = (receipt, item, pending, now = Date.now()) => ({
  confirmation: receipt.confirmation,
  command: receipt.command === true || undefined,
  submittedAt: receipt.submittedAt,
  acceptedAt: receipt.acceptedAt,
  hookReason: receipt.status === "rejected" ? receipt.hookReason : undefined,
  handedOffAt:
    receipt.status !== "handed-off" ||
    (item.status === "handed-off" && Number.isFinite(item.handedOffAt))
      ? item.handedOffAt
      : now,
  heldInCli:
    (receipt.status === "rejected" &&
      receipt.reason === "CHAT_HOOK_BLOCKED_DRAFT" &&
      (pending || item.heldInCli)) ||
    undefined,
});

// What the composer would send: its text and attachment paths, as enqueue builds it.
const composerBody = ({ text, attachments }) =>
  attachments.length
    ? [text.trimEnd(), ...attachments.map((file) => file.path)].filter(Boolean).join("\n")
    : text;

// The composer still holds exactly `item`, whose text may also sit in the CLI prompt.
const holds = (state, item) =>
  Boolean(item.heldInCli) &&
  item.status === "rejected" &&
  composerBody(state) === item.text;

/**
 * Whether sending would type a hook-blocked message a second time. Once the
 * owner changed the composer, it holds a different message and may be sent.
 */
export const sendHeld = (state) => state.recent.some((item) => holds(state, item));

/**
 * The draft without notice `id`. Dismissing a held message also clears its copy
 * in the composer: the message lives on in the CLI prompt, never twice.
 */
export function dismissed(saved, id) {
  const item = saved.recent.find((entry) => entry.id === id);
  const recent = saved.recent.filter((entry) => entry.id !== id);
  return item && holds(saved, item)
    ? { ...saved, recent, text: "", attachments: [] }
    : { ...saved, recent };
}

/** Keeps the last 20 finished handoffs; everything else stays until resolved. */
export const retainRecent = (items) => {
  const completed = items.filter((item) => delivered(item.status)).slice(-20);
  return items.filter((item) => !delivered(item.status) || completed.includes(item));
};

// A clock change in the browser never counts less than nothing.
const elapsed = (since, now) =>
  Number.isFinite(since) ? Math.max(0, now - since) : null;

/**
 * The confirmation view of `item` at browser time `now`, or null for today's
 * presentation (text-confirmed and older receipts). Shown views are chatDeliveryCopy
 * keys; "accepted" shows no notice of its own: a message gets the native "Accepted
 * by CLI" badge (native-delivery-state.js), a command nothing after its brief notice. The views: "accepted", "commandHandedOff",
 * "handed-off", "askCheck", "hookBlocked" or "hookBlockedDraft".
 */
export function deliveryView(item, now) {
  if (item.status === "accepted") {
    const since = item.command ? elapsed(item.acceptedAt, now) : null;
    return since !== null && since < COMMAND_NOTICE_MS ? "commandHandedOff" : "accepted";
  }
  if (item.status === "rejected" && item.reason === "CHAT_HOOK_BLOCKED")
    return "hookBlocked";
  if (item.status === "rejected" && item.reason === "CHAT_HOOK_BLOCKED_DRAFT")
    return "hookBlockedDraft";
  if (awaitsConfirmation(item)) {
    const since = elapsed(item.handedOffAt, now);
    return since !== null && since < ASK_AFTER_MS ? "handed-off" : "askCheck";
  }
  return null;
}

/** Milliseconds until the view of one of `items` changes by time alone, or null. */
export function nextDeliveryChange(items, now) {
  const waits = items.flatMap((item) => {
    const view = deliveryView(item, now);
    if (view === "handed-off") return [ASK_AFTER_MS - elapsed(item.handedOffAt, now)];
    if (view === "commandHandedOff")
      return [COMMAND_NOTICE_MS - elapsed(item.acceptedAt, now)];
    return [];
  });
  return waits.length ? Math.min(...waits) : null;
}

/**
 * Whether a live change re-reads `item`: an unconfirmed handoff without a
 * transcript row, until a minute after its ask. The server's later pushes of
 * a read item still apply.
 */
export function rereadable(item, now) {
  if (!awaitsConfirmation(item) || item.matchedMessageId) return false;
  const since = elapsed(item.handedOffAt, now);
  return since !== null && since < ASK_AFTER_MS + REREAD_AFTER_ASK_MS;
}

/**
 * Calls `tick` at each time-based view change of `items()`, re-arming after each
 * one until none is left. Returns the function that stops it.
 */
export function followDeliveryClock(items, tick, now = () => Date.now()) {
  let timer = null;
  const arm = () => {
    const wait = nextDeliveryChange(items(), now());
    if (wait === null) return;
    timer = setTimeout(() => {
      tick();
      arm();
    }, wait + 50);
  };
  arm();
  return () => clearTimeout(timer);
}
