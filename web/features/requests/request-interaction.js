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

export function recentlyUsedElsewhere(entry) {
  const interaction = entry.interaction;
  return Boolean(
    interaction &&
    interaction.client !== requestClient() &&
    interaction.age < interactionWindow,
  );
}
