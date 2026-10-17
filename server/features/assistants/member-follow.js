import { inheritsFromLead } from "./native-capabilities.js";

// Members whose profile the Gateway runs: provisioned and not ended yet.
const live = new Set(["ready", "admitting", "running", "stopping"]);

/**
 * Re-applies the running temporary members of `leadId` once the lead's entry changed
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
  for (const member of members)
    Promise.resolve()
      .then(() => assistants.admit(() => assistants.config.apply(member.id)))
      .catch(() => {});
}
