import { auditSecretGrants } from "./agent-secret-grants.js";

// Audit records of agent access changes (assistant-access.js): ids, levels, modes
// and secret names; never a token, a value or a description.

/** One record per GitHub access change: the profile id and levels, never a token. */
export function auditGithubAccess(services, id, before, after) {
  const from = before?.github || null,
    to = after?.github || null;
  if (from?.credentialId === to?.credentialId && from?.level === to?.level) return;
  try {
    services.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: id,
      source: "user",
      outcome: "success",
      details: {
        kind: "github-access",
        githubFrom: from?.level || "none",
        githubTo: to?.level || "none",
        ...((to || from) && { credentialId: (to || from).credentialId }),
      },
    });
  } catch (error) {
    console.error("Agent GitHub access audit failed:", error?.message);
  }
}
/**
 * One `assistant.updated` record per change of project grants or folder levels,
 * from the Work tab or the project's Agents section alike: project ids and levels.
 */
export function auditProjectGrants(services, id, before, after) {
  const from = new Set(before?.projectIds || []);
  const to = new Set(after?.projectIds || []);
  const added = [...to].filter((p) => !from.has(p)).sort();
  const removed = [...from].filter((p) => !to.has(p)).sort();
  const levels = (policy, p) => policy?.projectFiles?.[p] || "none";
  // A user agent's folders live in projectFiles alone (its projectIds stay empty).
  const folders = (policy) => Object.keys(policy?.projectFiles || {});
  const folderChanged = [
    ...new Set([...from, ...to, ...folders(before), ...folders(after)]),
  ]
    .sort()
    .filter((p) => levels(before, p) !== levels(after, p))
    .map((p) => ({ projectId: p, from: levels(before, p), to: levels(after, p) }));
  if (!added.length && !removed.length && !folderChanged.length) return;
  try {
    services.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: id,
      source: "user",
      outcome: "success",
      details: {
        kind: "project-grants",
        revision: after.revision,
        added,
        removed,
        folderChanged,
      },
    });
  } catch (error) {
    console.error("Agent project grant audit failed:", error?.message);
  }
}
/** One `assistant.updated` record per grant change: ids and modes, never more. */
export function auditSshGrants(services, id, before, after, reason) {
  const from = new Map((before?.sshAccesses || []).map((g) => [g.accessId, g.mode]));
  const to = new Map((after?.sshAccesses || []).map((g) => [g.accessId, g.mode]));
  const added = [...to.keys()].filter((k) => !from.has(k));
  const removed = [...from.keys()].filter((k) => !to.has(k));
  const modeChanged = [...to]
    .filter(([k, mode]) => from.has(k) && from.get(k) !== mode)
    .map(([accessId, mode]) => ({ accessId, from: from.get(accessId), to: mode }));
  if (!added.length && !removed.length && !modeChanged.length) return;
  try {
    services.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: id,
      source: "user",
      outcome: "success",
      details: {
        kind: "ssh-grants",
        revision: after.revision,
        added,
        removed,
        modeChanged,
        reason,
      },
    });
  } catch (error) {
    console.error("Agent SSH grant audit failed:", error?.message);
  }
}
/** Every record one owner save of an access policy writes. */
export function auditAccessSave(services, id, before, after) {
  auditSshGrants(services, id, before, after, "owner");
  auditProjectGrants(services, id, before, after);
  auditGithubAccess(services, id, before, after);
  auditSecretGrants(services, id, before, after);
}
