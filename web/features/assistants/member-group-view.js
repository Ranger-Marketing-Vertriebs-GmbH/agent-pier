// How a lead's permanent members sit in its named groups (server member-groups.js):
// each group with its members in their group order, and the members without a group.
// `permanent` are the lead's permanent member agents, `members` the team member
// records and `groups` every group of the list. Groups without members stay listed.
export function groupedMembers(leadId, permanent, members, groups = []) {
  const recordOf = (agent) => members.find((m) => m.assistantId === agent.id);
  const byMember = new Map(permanent.map((agent) => [recordOf(agent)?.id, agent]));
  const own = groups.filter((g) => g.parentAssistantId === leadId);
  const placed = new Set();
  const listed = own.map((group) => ({
    group,
    children: group.memberIds.flatMap((id) => {
      const agent = byMember.get(id);
      if (!agent || placed.has(agent.id)) return [];
      placed.add(agent.id);
      return [agent];
    }),
  }));
  return {
    groups: listed,
    ungrouped: permanent.filter((agent) => !placed.has(agent.id)),
  };
}
