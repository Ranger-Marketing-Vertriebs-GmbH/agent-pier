import api from "../../lib/api.js";
import { browserUuid } from "../../lib/browser-uuid.js";

// One identity per tab: a terminal in this tab may take over a question that
// this tab's chat touched, but not one someone answers on another device.
let client;
export function requestClient() {
  try {
    client ??= browserUuid();
  } catch {
    // Not a secret: it only tells this tab's interactions apart from others.
    client ??= `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return client;
}
// A question counts as "in use elsewhere" this long after the last interaction.
export const interactionWindow = 30000;
const throttle = 5000;
const sent = new Map();

export function touchRequest(request) {
  const now = Date.now();
  if (now - (sent.get(request.id) || 0) < throttle) return;
  sent.set(request.id, now);
  const path = `/sessions/${encodeURIComponent(request.sessionId)}/requests/${encodeURIComponent(request.id)}/touch`;
  // Best effort: a lost touch only weakens the cross-device guard.
  api(path, "POST", { client: requestClient() }).catch(() => sent.delete(request.id));
}

/**
 * Whether another tab or device used the request within `interactionWindow`. The age
 * is the server's at the moment this tab received the list (`receivedAt`, stamped by
 * the session requests store); a pushed list is sent only when it changes, so the
 * time since then counts too.
 */
export function recentlyUsedElsewhere(entry, now = Date.now()) {
  const interaction = entry.interaction;
  const age =
    (interaction?.age ?? Infinity) +
    (Number.isFinite(entry.receivedAt) ? Math.max(0, now - entry.receivedAt) : 0);
  return Boolean(
    interaction && interaction.client !== requestClient() && age < interactionWindow,
  );
}

// Terminal notices this tab already knows about: it released the request to
// the terminal itself, or the user dismissed the notice. Bounded per tab.
const settledNotices = new Set();
export function settleNotice(id) {
  settledNotices.add(id);
  if (settledNotices.size > 200)
    settledNotices.delete(settledNotices.values().next().value);
}
export function noticeSettled(id) {
  return settledNotices.has(id);
}
