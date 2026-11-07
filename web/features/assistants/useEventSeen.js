import { useState } from "react";
import { readSeenAt, storeSeenAt } from "./event-area.js";

/**
 * When this viewer last opened a chat's events (event-area.js): `seenAt`, read once
 * per chat, and `markSeen(events)`, which moves the mark past the newest event.
 */
export default function useEventSeen(conversationId) {
  const [seen, setSeen] = useState(() => ({
    conversationId,
    at: readSeenAt(conversationId),
  }));
  const seenAt =
    seen.conversationId === conversationId ? seen.at : readSeenAt(conversationId);
  const markSeen = (events = []) => {
    const at = Math.max(Date.now(), ...events.map((event) => event.at));
    storeSeenAt(conversationId, at);
    setSeen({ conversationId, at });
  };
  return { seenAt, markSeen };
}
