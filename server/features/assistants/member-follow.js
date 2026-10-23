import { inheritsFromLead } from "./native-capabilities.js";

// Members whose profile the Gateway runs: provisioned and not ended yet.
const live = new Set(["ready", "admitting", "running", "stopping"]);

/**
 * Re-applies the running temporary members of `leadId` (and its permanent members
 * with a shared capability) once the lead's entry changed
 * (or its member shell and SSH setting), so they lose or regain a granted capability
 * now rather than at their next turn. Each apply waits for admission and its failure
 * only leaves the member to its next turn's apply, which compiles the same values.
 */
export function followLead(assistants, leadId) {
  if (!assistants.runtime?.client?.ready || !assistants.teams?.store) return;
  let members;
  try {
    members = assistants.store
      .listAssistants()
      .filter(
        (a) =>
          a.parentAssistantId === leadId &&
          inheritsFromLead(a) &&
          live.has(assistants.teams.store.find(a.teamMemberId)?.phase),
      );
  } catch {
    return;
  }
  for (const member of [...members, ...capabilityMembers(assistants, leadId)])
    Promise.resolve()
      .then(() => assistants.admit(() => assistants.config.apply(member.id)))
      .catch(() => {});
}

/**
 * The permanent members `leadId` shares a capability with (Read images,
 * lead-capability-shares.js): they gain or lose it with the lead's own switch. A
 * share the lead no longer backs is pruned first, so it ends for good.
 */
function capabilityMembers(assistants, leadId) {
  const shares = assistants.workflows?.shares;
  if (!shares) return [];
  try {
    const ids = new Set(
      shares
        .rows()
        .filter((row) => row.kind === "capability" && row.leadId === leadId)
        .map((row) => row.memberAssistantId),
    );
    if (!ids.size) return [];
    shares.prune();
    return [...ids].map((id) => ({ id }));
  } catch {
    return [];
  }
}
