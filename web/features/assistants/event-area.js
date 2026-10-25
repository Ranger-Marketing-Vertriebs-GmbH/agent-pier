import { hookCopy } from "../../lib/i18n/messages/assistant-hooks.js";
import { routineCopy } from "../../lib/i18n/messages/assistant-routines.js";

// The chat's event area (AgentEventArea.jsx): routine, check-in and hook events of
// the conversation view (server/features/assistants/agent-event-area.js).
const icons = { routine: "history", checkin: "refresh", hook: "link" };
const tones = {
  running: "running",
  done: "ok",
  failed: "error",
  throttled: "neutral",
  silent: "neutral",
};

/**
 * The group's head: how many events, how many arrived after `seenAt` (the viewer
 * last opened the group), whether one runs, and the unseen failures (they stay
 * visible while the group is shut until it is opened).
 */
export function eventAreaView(events, seenAt) {
  const since = Number(seenAt) || 0;
  const unseen = events.filter((event) => event.at > since);
  const unread = unseen.length;
  const copy = hookCopy.events;
  return {
    count: events.length,
    summary: [copy.count(events.length), unread > 0 && copy.unread(unread)]
      .filter(Boolean)
      .join(" · "),
    running: events.some((event) => event.status === "running"),
    failed: unseen.filter((event) => event.status === "failed").length,
    unread,
  };
}

/** Machine notes of a run (e.g. `ssh_refused`) the owner can read. */
export const noteTexts = (notes = []) =>
  notes.includes("ssh_refused") ? [routineCopy.sshRefused] : [];

/**
 * One event as an activity row: icon by source, the name (a hook's with its
 * sender), the reply's first line (else a readable note) with duplicates, and the
 * status chip.
 */
export function eventRowView(event) {
  const copy = hookCopy.events;
  const name =
    event.name ||
    (event.source === "checkin"
      ? copy.checkIn
      : event.source === "hook"
        ? hookCopy.unknownName
        : "");
  const label =
    event.source === "hook" && event.sender ? `${name} · ${event.sender}` : name;
  const detail = [
    event.test && copy.test,
    event.firstLine || noteTexts(event.notes)[0],
    event.duplicates > 0 && copy.duplicates(event.duplicates),
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    icon: icons[event.source] || "history",
    label,
    detail,
    status: copy.states[event.status] || copy.states.failed,
    tone: tones[event.status] || "error",
  };
}

const seenKey = (conversationId) => `agentpier-event-area-seen:${conversationId}`;

/** When this viewer last opened the chat's event area (a per-browser convenience). */
export function readSeenAt(conversationId) {
  try {
    return Number(localStorage.getItem(seenKey(conversationId))) || 0;
  } catch {
    return 0;
  }
}

export function storeSeenAt(conversationId, at) {
  try {
    localStorage.setItem(seenKey(conversationId), String(at));
  } catch {
    // Without storage the unread count simply starts again on reload.
  }
}
