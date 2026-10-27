import { assistantProblem, textValue } from "../assistant-validation.js";
import { isUserAgent } from "../../users/user-access.js";

// The email accounts one agent may hold (assistant-access.js `mailAccesses`): each a
// level ("read" or "send") and, for "send", the recipients it may write to without
// asking the owner.
export const mailLevels = Object.freeze(["read", "send"]);
export const maxMailGrants = 20;
export const maxMailRecipients = 50;
const grantKeys = ["accountId", "level", "recipients"];
const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// A domain of two labels or more, ASCII (an international one in its xn-- form).
const domainPattern = new RegExp(`^(?=.{1,253}$)${label}(?:\\.${label})+$`);
// The local part of an addr-spec without quoting, comments or whitespace.
const localPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/;

const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const byAccountId = (x, y) =>
  x.accountId < y.accountId ? -1 : x.accountId > y.accountId ? 1 : 0;

// "local@domain" or "domain", lower case; null for anything else.
function ruleParts(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  const at = text.lastIndexOf("@");
  const domain = text.slice(at + 1);
  if (!domainPattern.test(domain)) return null;
  if (at < 0) return { domain };
  const local = text.slice(0, at);
  return localPattern.test(local) ? { local, domain } : null;
}

/** One recipient rule as stored: an address or a domain, lower case; else a 400. */
export function recipientRule(value) {
  textValue(value, 320);
  const parts = ruleParts(value);
  if (!parts) throw assistantProblem("invalid");
  return parts.local === undefined ? parts.domain : `${parts.local}@${parts.domain}`;
}

/**
 * Whether one plain recipient address (an addr-spec, no display name) matches a
 * rule: an address rule matches that address case-insensitively; a domain rule
 * matches that exact domain, never a subdomain or a longer name.
 */
export function recipientAllowed(rules, address) {
  const parts = ruleParts(address);
  if (!parts || parts.local === undefined || !Array.isArray(rules)) return false;
  const full = `${parts.local}@${parts.domain}`;
  return rules.some((rule) => rule === full || rule === parts.domain);
}

/**
 * The accounts the owner's Access tab offers: id, name and address only, never a
 * server, username or password; null while the store is missing or unreadable.
 */
export function mailCatalog(services) {
  try {
    const list = services.mailAccounts?.list();
    return list ? list.map(({ id, name, address }) => ({ id, name, address })) : null;
  } catch {
    return null;
  }
}

function grantInput(entry, seen) {
  if (!plain(entry) || Object.keys(entry).some((key) => !grantKeys.includes(key)))
    throw assistantProblem("invalid");
  textValue(entry.accountId, 100);
  if (!mailLevels.includes(entry.level) || seen.has(entry.accountId))
    throw assistantProblem("invalid");
  seen.add(entry.accountId);
  const raw = entry.recipients === undefined ? [] : entry.recipients;
  if (!Array.isArray(raw) || raw.length > maxMailRecipients)
    throw assistantProblem("invalid");
  const rules = [...new Set(raw.map(recipientRule))].sort();
  // Only a sending grant keeps rules: reading never sends.
  return {
    accountId: entry.accountId,
    level: entry.level,
    recipients: entry.level === "send" ? rules : [],
  };
}

/**
 * A replaced mail grant list: catalog accounts with a level, sorted by account id.
 * An unknown account is a 409, an unreadable catalog a 503; an agent with its own
 * Telegram bot for other people never gets one (telegram-senders.js). Who may hold
 * mail at all is checked by the caller (AssistantAccess.prepare).
 */
export function mailGrantList(services, assistantId, value) {
  if (!Array.isArray(value) || value.length > maxMailGrants)
    throw assistantProblem("invalid");
  const seen = new Set();
  const list = value.map((entry) => grantInput(entry, seen));
  if (!list.length) return list;
  const catalog = mailCatalog(services);
  if (!catalog) throw assistantProblem("catalogUnreadable", 503);
  if (list.some((g) => !catalog.some((account) => account.id === g.accountId)))
    throw assistantProblem("mailAccountUnavailable", 409);
  if (services.assistantTelegramSenders?.connected(assistantId))
    throw assistantProblem("telegramSendersMail", 409);
  return list.sort(byAccountId);
}

const sameGrant = (x, y) =>
  x.level === y.level && JSON.stringify(x.recipients) === JSON.stringify(y.recipients);

/**
 * One `assistant.updated` record per grant change: account ids and the number of
 * recipient rules, never an address or a rule (audit-mail-details.js).
 */
export function auditMailGrants(services, id, before, after, reason) {
  const from = new Map((before?.mailAccesses || []).map((g) => [g.accountId, g]));
  const to = new Map((after?.mailAccesses || []).map((g) => [g.accountId, g]));
  const added = [...to.keys()].filter((k) => !from.has(k)).sort();
  const removed = [...from.keys()].filter((k) => !to.has(k)).sort();
  const changed = [...to.keys()]
    .filter((k) => from.has(k) && !sameGrant(from.get(k), to.get(k)))
    .sort();
  if (!added.length && !removed.length && !changed.length) return;
  try {
    services.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: id,
      source: reason === "owner" ? "user" : "system",
      outcome: "success",
      details: {
        kind: "mail-grants",
        revision: after.revision,
        added,
        removed,
        changed,
        ruleCount: [...to.values()].reduce((n, g) => n + g.recipients.length, 0),
        reason,
      },
    });
  } catch (error) {
    console.error("Agent mail grant audit failed:", error?.message);
  }
}

/**
 * Removes one email account from every agent's grants in one transaction, together
 * with `during` (AssistantAccess.revokeEach keeps the approval revision); one audit
 * record per changed agent. Returns the agents whose grants changed.
 */
export function revokeMailGrants(access, accountId, during) {
  const changed = access.revokeEach(
    (before) =>
      before.mailAccesses.some((g) => g.accountId === accountId) && {
        mailAccesses: before.mailAccesses.filter((g) => g.accountId !== accountId),
      },
    during,
  );
  for (const c of changed)
    auditMailGrants(access.s, c.id, c.before, c.after, "account-removed");
  if (changed.length) access.s.assistants.changed();
  return changed.map((c) => c.id);
}

/**
 * An agent's grant for one email account, read live: only the owner's own agents and
 * permanent members (AssistantAccess.eligible), never a user agent, a temporary
 * member through its lead, or an agent with its own Telegram bot for other people.
 * `catalog` (mailCatalog) lets a caller that checks several grants read it once.
 */
export function heldMailGrant(access, id, accountId, catalog = mailCatalog(access.s)) {
  try {
    const agent = access.eligible(id);
    if (isUserAgent(agent) || access.s.assistantTelegramSenders?.connected(id))
      return null;
    // The account must still be listed: an unreadable catalog grants nothing.
    if (!catalog?.some((account) => account.id === accountId)) return null;
    return access.stored(id).mailAccesses.find((g) => g.accountId === accountId) || null;
  } catch {
    return null;
  }
}

/**
 * The policy as read: `mailAccesses` holds only accounts that still exist (one
 * removed while agents were off, or dropped by a restore). While the catalog cannot
 * be read the stored grants stay, so a save that leaves them out keeps them.
 */
export function withLiveMail(services, policy) {
  if (!policy.mailAccesses.length) return policy;
  const catalog = mailCatalog(services);
  if (!catalog) return policy;
  const known = new Set(catalog.map((account) => account.id));
  return {
    ...policy,
    mailAccesses: policy.mailAccesses.filter((g) => known.has(g.accountId)),
  };
}
