import { problem } from "../lib/storage.js";
import { serverMessages } from "../lib/i18n/de.js";

// Allow and Deny on an approval push (public/sw.js): the owner decides one inbox item
// from the notification without opening AgentPier. The push names the item and its
// revision; the server decides only if that exact item still waits at that revision
// and offers only a once-only allow, never "always" or a session- or turn-wide rule.

const denyChoices = ["deny", "decline", "reject"];

/**
 * A CLI permission's choices for a push: `allow` is its once-only option, `deny` its
 * plain refusal. Plans, trust prompts and startup prompts are never decided from a push.
 */
export function requestDecisions(entry) {
  if (
    entry?.kind !== "permission" ||
    entry.status !== "pending" ||
    entry.presentation ||
    entry.subject?.plan ||
    !Array.isArray(entry.options)
  )
    return {};
  const allow = entry.options.find((option) => option.scope === "once");
  const deny = entry.options.find((option) => denyChoices.includes(option.id));
  return {
    ...(allow && deny ? { allow: allow.id } : {}),
    ...(deny ? { deny: deny.id } : {}),
  };
}

// Agent approvals a push may allow: never a shell, SSH, SFTP or mail action, whose
// content the notification never shows (Telegram approves those only when it showed
// them in full). These may still be denied.
const allowable = new Set([
  "coding_start",
  "session_start",
  "memory_write",
  "member_grant",
]);
const deniable = new Set([...allowable, "exec", "ssh", "sftp", "mail_send"]);

/** An agent action's decisions for a push, in its own vocabulary. */
export function actionDecisions(action) {
  const kind = action?.payload?.action;
  if (action?.state !== "awaiting_approval" || !deniable.has(kind)) return {};
  const exec = kind === "exec";
  return {
    ...(allowable.has(kind) ? { allow: "approve" } : {}),
    deny: exec ? "deny" : "decline",
  };
}

/** What the push offers: "both", "deny" or nothing. */
export function decideMode(decisions) {
  if (decisions.allow && decisions.deny) return "both";
  return decisions.deny ? "deny" : undefined;
}

const stale = () => problem(serverMessages.notifications.decisionStale, 409);
const invalid = () => problem(serverMessages.notifications.invalidDecision, 400);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

/** Decides the item a push named; refuses anything that changed since it was sent. */
export async function decideFromPush(services, input) {
  const { type, id, revision, decision } = input || {};
  if (
    !["approval", "action"].includes(type) ||
    typeof id !== "string" ||
    !idPattern.test(id) ||
    !Number.isSafeInteger(revision) ||
    !["allow", "deny"].includes(decision)
  )
    throw invalid();
  if (type === "approval") {
    const entry = services.requests?.listAll?.().find((item) => item.id === id);
    if (!entry || entry.revision !== revision) throw stale();
    const choice = requestDecisions(entry)[decision];
    if (!choice) throw stale();
    await services.requests.answer(entry.sessionId, id, {
      expectedRevision: revision,
      choice,
    });
    return { decided: decision };
  }
  const workflows = services.assistants?.workflows;
  let action;
  try {
    action = workflows?.store.get(id);
  } catch {
    action = null;
  }
  if (!action || action.revision !== revision) throw stale();
  const value = actionDecisions(action)[decision];
  if (!value) throw stale();
  // decide() checks the audience (an owner's item only), revision, state and expiry.
  await workflows.decide(
    id,
    { revision, decision: value },
    { kind: "owner", channel: "push" },
  );
  return { decided: decision };
}
