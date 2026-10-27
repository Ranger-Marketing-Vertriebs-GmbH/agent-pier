import { formatMessageTime, locale } from "../../lib/i18n/index.js";
import { inboxCopy as copy } from "../../lib/i18n/messages/inbox.js";

// Must match the server's window (server/features/inbox/inbox-items.js).
export const expiringSoonMs = 15 * 60000;
const icons = {
  question: "help",
  approval: "shield",
  gate: "check",
  action: "terminal",
  team: "users",
};
export const itemIcon = (item) => icons[item.type] || "inbox";

/** What waits, in words: the specific kind where one is known, else the type. */
export function kindLabel(item) {
  return copy.kinds[item.kind] || copy.types[item.type] || "";
}

/** The row's first line: the item's own title, or what kind of decision it is. */
export const itemTitle = (item) => item.title || kindLabel(item);

/** Kind and source, e.g. "Shell command · Helper". */
export function itemContext(item) {
  const kind = kindLabel(item);
  const parts = [item.title && kind !== item.title ? kind : copy.types[item.type]];
  if (item.source?.name) parts.push(item.source.name);
  if (item.source?.project) parts.push(item.source.project);
  return parts.filter(Boolean).join(" · ");
}

/**
 * Which agent a session request concerns: the one that escalated it to the owner,
 * else the one that started the session; empty for the owner's own sessions.
 */
export function itemAgentLine(item) {
  if (item.escalation) return copy.escalatedBy(item.escalation.agentName);
  if (item.agent) return copy.agentSession(item.agent.name);
  return "";
}

function relative(time, now) {
  const seconds = Math.round((time - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ])
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(seconds, "second");
}

/** "Expires in 4 minutes" for an item about to expire, else since when it waits. */
export function itemTime(item, now = Date.now()) {
  const expires = item.expiresAt ? Date.parse(item.expiresAt) : NaN;
  if (Number.isFinite(expires) && expires - now <= expiringSoonMs)
    return { text: copy.expires(relative(expires, now)), urgent: true };
  return { text: copy.waitingSince(formatMessageTime(item.createdAt)), urgent: false };
}
