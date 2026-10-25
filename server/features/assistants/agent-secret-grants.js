import { assistantProblem, textValue } from "./assistant-validation.js";

// The secrets one agent may hold (docs/secrets.md).
export const maxAgentSecrets = 50;

// Names by id of the secrets the store (secret-store.js) still knows, read without
// values; null while the store is missing or unreadable.
function knownSecrets(services) {
  try {
    const names = services.secrets?.names();
    return names ? new Map(names.map((s) => [s.id, s.name])) : null;
  } catch {
    return null;
  }
}
const storedList = (ids) => (Array.isArray(ids) ? ids : []);

/**
 * The policy as read: `secretIds` holds only secrets that still exist. While the
 * store cannot be read the stored ids stay, so a save that leaves them out keeps
 * them instead of writing an empty list.
 */
export function withLiveSecrets(services, policy) {
  const known = knownSecrets(services);
  const ids = storedList(policy.secretIds);
  return { ...policy, secretIds: known ? ids.filter((id) => known.has(id)) : ids };
}

/**
 * A replaced secret grant list: known secret ids, unique and sorted. An id the
 * agent held (`stored`, its policy as written) whose secret was deleted since is
 * dropped instead of refused, so a stale list never blocks the owner's save; any
 * other unknown id is a 409, and an unreadable store a 503. An agent with its own
 * bot for other people never gets one (telegram-senders.js).
 */
export function secretGrantList(services, id, value, stored = []) {
  if (
    !Array.isArray(value) ||
    value.length > maxAgentSecrets ||
    new Set(value).size !== value.length
  )
    throw assistantProblem("invalid");
  for (const entry of value) textValue(entry, 100);
  if (!value.length) return [];
  const known = knownSecrets(services);
  // An unreadable store cannot tell a deleted secret from a granted one.
  if (!known) throw assistantProblem("unavailable", 503);
  const held = new Set(storedList(stored));
  const list = value.filter((entry) => {
    if (known.has(entry)) return true;
    if (held.has(entry)) return false;
    throw assistantProblem("secretUnavailable", 409);
  });
  if (list.length && services.assistantTelegramSenders?.connected(id))
    throw assistantProblem("telegramSendersSecrets", 409);
  return list.sort();
}

/** One `assistant.updated` record per grant change: secret names, never values. */
export function auditSecretGrants(services, id, before, after) {
  const from = new Set(before?.secretIds || []);
  const to = new Set(after?.secretIds || []);
  const known = knownSecrets(services) || new Map();
  const names = (ids) =>
    ids
      .map((s) => known.get(s))
      .filter(Boolean)
      .sort();
  const added = names([...to].filter((s) => !from.has(s)));
  const removed = names([...from].filter((s) => !to.has(s)));
  if (!added.length && !removed.length) return;
  try {
    services.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: id,
      source: "user",
      outcome: "success",
      details: { kind: "secret-grants", revision: after.revision, added, removed },
    });
  } catch (error) {
    console.error("Agent secret grant audit failed:", error?.message);
  }
}
