import { assistantProblem, textValue } from "./assistant-validation.js";

// The secrets one agent may hold (docs/secrets.md).
export const maxAgentSecrets = 50;

// Ids the secret store (secret-store.js) still knows; none while it is unavailable.
function knownSecrets(services) {
  try {
    return new Map((services.secrets?.list() || []).map((s) => [s.id, s.name]));
  } catch {
    return new Map();
  }
}
// The ids the agent's stored policy names, deleted secrets included.
function storedSecretIds(services, id) {
  const row = services.assistants.store.db
    .prepare(
      "SELECT json_extract(body,'$.secretIds') AS ids FROM assistant_access WHERE assistant_id=?",
    )
    .get(id);
  const ids = row?.ids ? JSON.parse(row.ids) : [];
  return Array.isArray(ids) ? ids : [];
}

/** The policy as read: `secretIds` holds only secrets that still exist. */
export function withLiveSecrets(services, policy) {
  const known = knownSecrets(services);
  return {
    ...policy,
    secretIds: (policy.secretIds || []).filter((id) => known.has(id)),
  };
}

/**
 * A replaced secret grant list: known secret ids, unique and sorted. An id the
 * agent held whose secret was deleted since is dropped instead of refused, so a
 * stale list never blocks the owner's save; any other unknown id is a 409. An
 * agent with its own bot for other people never gets one (telegram-senders.js).
 */
export function secretGrantList(services, id, value) {
  if (
    !Array.isArray(value) ||
    value.length > maxAgentSecrets ||
    new Set(value).size !== value.length
  )
    throw assistantProblem("invalid");
  for (const entry of value) textValue(entry, 100);
  if (!value.length) return [];
  const known = knownSecrets(services);
  const stored = new Set(storedSecretIds(services, id));
  const list = value.filter((entry) => {
    if (known.has(entry)) return true;
    if (stored.has(entry)) return false;
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
  const known = knownSecrets(services);
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
