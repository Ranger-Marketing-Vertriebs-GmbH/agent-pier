import { memberEnded } from "./member-reach.js";
import { resyncDeliveries } from "./main-chat-swap.js";
import { chatFree, moveChannelsOf, swapChat } from "./model-switch.js";

/**
 * The chats a model switch could not replace at once (model-switch.js swapNow): a
 * turn ran in them, or their swap failed before it committed. Each is held in its own
 * row, so a restart keeps it, and swapped with the switch's note as soon as it is
 * free; a turn is never cut for it. A held chat that was archived, deleted or already
 * replaced since, whose agent was archived, or whose member moved to another chat or
 * finished its task (a temporary one) is dropped; after a day the swap is given up.
 * The service's poll ticks it (queued-dispatch.js pollQueued).
 */
const giveUpAfterMs = 24 * 60 * 60 * 1000;
// A swap that failed is tried again after this pause, not on every poll.
const retryAfterMs = 60 * 1000;

export class DeferredSwaps {
  constructor({ service }) {
    this.service = service;
    this.db = service.store.db;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_deferred_swaps (conversation_id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
    this.running = null;
  }
  /**
   * Holds `conversationId` for its swap: `swap` names its agent (`assistantId`), the
   * member row of a member's chat (`memberId`) and the note's model names
   * (`details`). Holding it again keeps when it was first held and the first model it
   * left, and takes the newest model it moves to.
   */
  add(conversationId, { assistantId, memberId, details }) {
    const held = this.get(conversationId);
    const body = {
      assistantId,
      ...(memberId ? { memberId } : {}),
      details: held ? { from: held.details?.from, to: details?.to } : details,
      heldAt: held?.heldAt ?? new Date(this.now()).toISOString(),
    };
    this.db
      .prepare("INSERT OR REPLACE INTO assistant_deferred_swaps VALUES(?,?)")
      .run(conversationId, JSON.stringify(body));
  }
  get(conversationId) {
    const row = this.db
      .prepare("SELECT body FROM assistant_deferred_swaps WHERE conversation_id=?")
      .get(conversationId);
    return row ? JSON.parse(row.body) : null;
  }
  /** Every held chat, `{ conversationId, ... }`. */
  list() {
    return this.db
      .prepare("SELECT conversation_id, body FROM assistant_deferred_swaps")
      .all()
      .map((row) => ({ conversationId: row.conversation_id, ...JSON.parse(row.body) }));
  }
  drop(conversationId) {
    this.db
      .prepare("DELETE FROM assistant_deferred_swaps WHERE conversation_id=?")
      .run(conversationId);
  }
  now() {
    return this.service.now?.() ?? Date.now();
  }
  /** Swaps each held chat that is free now; one pass at a time. Never throws. */
  tick() {
    this.running ??= this.pass()
      .catch((error) => console.error("Model switch: held swaps failed:", error?.message))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  async pass() {
    const service = this.service;
    for (const held of this.list()) {
      if (service.closed || service.recovering || service.maintenance) return;
      try {
        await this.attempt(held);
      } catch (error) {
        console.error("Model switch: a held chat swap failed:", error?.message);
      }
    }
  }
  async attempt(held) {
    const { conversationId } = held;
    const now = this.now();
    if (now - Date.parse(held.heldAt) > giveUpAfterMs) {
      console.error(
        "Model switch: gave up swapping a chat that stayed busy for a day:",
        conversationId,
      );
      return this.drop(conversationId);
    }
    if (held.retryAt && Date.parse(held.retryAt) > now) return;
    if (!this.current(held)) return this.drop(conversationId);
    if (!chatFree(this.service, conversationId)) return;
    let landed = null;
    const swapped = await this.service.admit(async () => {
      // Checked again inside admission: a turn may have started meanwhile.
      const conversation = this.current(held);
      if (!conversation) return "gone";
      if (!chatFree(this.service, conversationId)) return "busy";
      try {
        await swapChat(this.service, { ...held, conversation }, (next) => {
          landed = next;
        });
      } catch (error) {
        console.error("Model switch: a held chat was not swapped:", error?.message);
      }
      if (landed) moveChannelsOf(this.service, held.assistantId);
      return landed ? "swapped" : "failed";
    });
    if (swapped === "busy") return;
    if (swapped === "failed") {
      const retryAt = new Date(now + retryAfterMs).toISOString();
      return this.write(conversationId, { ...held, retryAt });
    }
    this.drop(conversationId);
    if (swapped === "swapped")
      await resyncDeliveries(this.service, held.assistantId).catch((error) =>
        console.error("Model switch: deliveries did not resync:", error?.message),
      );
  }
  write(conversationId, { conversationId: _id, ...body }) {
    this.db
      .prepare("UPDATE assistant_deferred_swaps SET body=? WHERE conversation_id=?")
      .run(JSON.stringify(body), conversationId);
  }
  // The held chat while its swap still applies, else null (it is dropped).
  current({ conversationId, assistantId, memberId }) {
    const { store, teams } = this.service;
    try {
      const conversation = store.getConversation(conversationId);
      if (conversation.archivedAt || conversation.successorId) return null;
      if (store.getAssistant(assistantId).archivedAt) return null;
      if (!memberId) return conversation.main === true ? conversation : null;
      const member = teams.store.member(memberId);
      if (member.archivedAt || member.conversationId !== conversationId) return null;
      // A temporary member whose task ended first needs no swap.
      if (member.lifetime !== "permanent" && memberEnded.has(member.phase)) return null;
      return conversation;
    } catch {
      return null; // The chat, its agent or the member row went away.
    }
  }
}

const held = new WeakMap();

/** The service's held swaps, read from its database the first time they are asked. */
export function deferredSwaps(service) {
  let swaps = held.get(service);
  if (!swaps) held.set(service, (swaps = new DeferredSwaps({ service })));
  return swaps;
}
