import { setSshGrant, sortedIds } from "../assistants/settings/agent-settings-fields.js";

// Granting and revoking from Zugänge ("Benutzt von", bulk actions) writes the same
// agent settings as the agent's Access tab: `PUT /assistants/:id/work` with the access
// half and its revision (assistant-access.js, docs/settings-pattern.md), and for MCP
// servers `PATCH /assistants/:id` with `mcpServers`. Nothing here widens what the
// server accepts; a refusal (409 conflict, locked agent, Telegram senders) is reported
// per agent and never retried.

// The kinds of grant an access policy holds, and their modes.
export const grantKinds = ["ssh", "secret", "github"];
export const sshGrantModes = ["approval", "trusted", "routines"];
export const githubLevels = ["read", "write"];

/** The access half of a work save: the policy's fields with one grant changed. */
export function grantAccessBody(policy, { kind, itemId, mode = null }) {
  const body = {
    revision: policy.revision,
    projectIds: policy.projectIds || [],
    pipelineIds: policy.pipelineIds || [],
    memoryWrite: policy.memoryWrite === true,
    autonomous: policy.autonomous === true,
    publish: policy.publish === true,
  };
  if (kind === "ssh")
    return { ...body, sshAccesses: setSshGrant(policy.sshAccesses || [], itemId, mode) };
  if (kind === "secret") {
    const ids = (policy.secretIds || []).filter((id) => id !== itemId);
    return { ...body, secretIds: sortedIds(mode ? [...ids, itemId] : ids) };
  }
  if (kind === "github") {
    // Revoking another profile's access would remove a grant this entry does not own.
    if (!mode && policy.github?.credentialId !== itemId) return null;
    return { ...body, github: mode ? { credentialId: itemId, level: mode } : null };
  }
  throw new Error(`Unknown grant kind ${kind}`);
}

/** The grant `policy` holds for the entry: its mode, true for a secret, else null. */
export function currentGrant(policy, { kind, itemId }) {
  if (kind === "ssh")
    return (policy.sshAccesses || []).find((g) => g.accessId === itemId)?.mode ?? null;
  if (kind === "secret") return (policy.secretIds || []).includes(itemId) || null;
  if (kind === "github")
    return policy.github?.credentialId === itemId ? policy.github.level : null;
  return null;
}

/** Bulk: several SSH hosts at once, each set to `mode` (null revokes). */
export function sshGrantsBody(policy, accessIds, mode) {
  const body = grantAccessBody(policy, { kind: "ssh", itemId: accessIds[0], mode });
  let grants = policy.sshAccesses || [];
  for (const id of accessIds) grants = setSshGrant(grants, id, mode);
  return { ...body, sshAccesses: grants };
}

/** The `mcpServers` of an agent with `serverIds` added (or removed). */
export function mcpServersWith(current, serverIds, add) {
  const list = current || [];
  return add
    ? [...list, ...serverIds.filter((id) => !list.includes(id))]
    : list.filter((id) => !serverIds.includes(id));
}

/**
 * Agents the owner can grant shared credentials to: own personal agents that are not
 * archived. Temporary members use their lead's grants, and agents of users stay locked
 * (user-agent-lock.js), so neither is offered.
 */
export function grantableAgents(assistants) {
  return (assistants || []).filter(
    (agent) =>
      !agent.archivedAt &&
      !agent.userAccess &&
      (!agent.teamMemberId || agent.lifetime === "permanent"),
  );
}

/** Agents that take MCP servers from the owner (connect-plan.js ownerManaged). */
export const mcpAgents = (assistants) =>
  (assistants || []).filter((item) => Array.isArray(item.mcpServers) && !item.archivedAt);
