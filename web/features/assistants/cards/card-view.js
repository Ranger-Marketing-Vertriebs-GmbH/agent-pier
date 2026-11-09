// Pure helpers of the agent cards in the chat (AgentCard.jsx; tests/unit/agent-card-view.test.js).

const cardOf = (message) => message?.card?.id ?? message?.cardMoved?.id ?? null;

/**
 * The chat's rows without a card's marker that the card itself (or another marker of
 * it) follows directly: an update with nothing in between leaves no trace.
 */
export function withoutAdjacentMarkers(messages) {
  return messages.filter(
    (message, i) =>
      !message.cardMoved || cardOf(messages[i + 1]) !== message.cardMoved.id,
  );
}

/** The status dot tone of a status tile's state. */
export const stateTone = { ok: "ok", warn: "warning", fail: "error", unknown: "unknown" };

/**
 * A card's blocks with the ticks the person just made (`pending`: key → checked)
 * shown before the chat's feed confirms them. Keys are `version:block:item`.
 */
export function withPendingTicks(card, pending) {
  if (!pending.size) return card.blocks;
  return card.blocks.map((block, index) =>
    block.type === "checklist"
      ? {
          ...block,
          items: block.items.map((item) => {
            const key = tickKey(card.version, index, item.id);
            return pending.has(key) ? { ...item, checked: pending.get(key) } : item;
          }),
        }
      : block,
  );
}
export const tickKey = (version, block, item) => `${version}:${block}:${item}`;

/**
 * The pending ticks still to show over `card` as the feed now has it: a tick the
 * card already shows, or one of another version, is settled and dropped.
 */
export function unsettledTicks(card, pending) {
  const next = new Map(pending);
  for (const key of pending.keys()) {
    const [version, block, ...item] = key.split(":");
    const shown = card.blocks[Number(block)]?.items?.find(
      (entry) => entry.id === item.join(":"),
    );
    if (Number(version) !== card.version || !shown || shown.checked === pending.get(key))
      next.delete(key);
  }
  return next.size === pending.size ? pending : next;
}
