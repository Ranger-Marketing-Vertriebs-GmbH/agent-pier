// An agent's message to a session the CLI has not taken yet: ChatDelivery holds it
// behind a running turn or an open prompt (pending), or waits for the CLI's
// acceptance event (handed-off, uncertain). SessionTalk's pass follows each such
// send until its receipt settles, then updates the row, which the sending chat
// shows live and the agent reads back (`read` lists its recent sends).
import { sessionScope } from "../../chat/chat-delivery.js";

// As long as ChatDelivery waits for a busy session (12 h), and a little longer.
export const followMs = 13 * 60 * 60 * 1000;
const open = new Set(["pending", "handed-off", "uncertain"]);

/**
 * Whether a receipt may still change: pending, uncertain, or handed off while an
 * acceptance event is still due. A text-confirmed hand-off is final.
 */
export function stillOpen(receipt) {
  if (!open.has(receipt?.status)) return false;
  return receipt.status !== "handed-off" || receipt.confirmation === "events";
}

/** The row fields a receipt settles to; `settled` marks a final hand-off. */
export function sendOutcome(receipt, status) {
  return { status, settled: !stillOpen(receipt) };
}

/** The ids of the open sends to follow, after a restart (TalkStore.openSends). */
export function seedFollowing(talk) {
  for (const row of talk.store.openSends(talk.now() - followMs))
    if (!row.settled) talk.following.add(row.id);
}

// Only the sending chat shows the row: its feed is read again and pushed live.
function changedChat(talk, row) {
  try {
    talk.w.a.changed?.(row.conversationId ? { conversationId: row.conversationId } : {});
  } catch {
    /* The live push follows on the next change. */
  }
}

/** One pass over the followed sends; a settled or vanished one is no longer followed. */
export async function followSends(talk) {
  for (const id of [...talk.following]) {
    if (talk.closed) return;
    const row = talk.store.get(id);
    if (!row || row.op !== "send" || talk.now() - row.createdAt > followMs) {
      talk.following.delete(id);
      continue;
    }
    let receipt;
    try {
      const session = await talk.w.s.sessions.get(row.sessionId);
      receipt = await talk.w.s.chatDelivery.status(
        row.sessionId,
        row.deliveryId,
        sessionScope(session),
      );
    } catch (error) {
      // Removed or replaced (another scope): nothing will settle any more.
      if ([404, 409].includes(error?.status)) talk.following.delete(id);
      continue;
    }
    if (!receipt || receipt.status === "absent") {
      talk.following.delete(id);
      continue;
    }
    if (stillOpen(receipt)) {
      if (receipt.status !== row.status) {
        talk.store.patch(id, { status: receipt.status });
        changedChat(talk, row);
      }
      continue;
    }
    talk.following.delete(id);
    talk.store.patch(id, sendOutcome(receipt, receipt.status));
    changedChat(talk, row);
  }
}
