import { ownerSorted } from "../order/agent-order.js";

// Group assignments apply to roots only. Members follow their lead, even when
// the lead is archived and a permanent member is shown on its own.
export function groupOf(groups, id) {
  return groups.find((g) => g.assistantIds.includes(id))?.id ?? null;
}
export function areaSections(agents, groups) {
  const membership = new Map(
    groups.flatMap((g) => g.assistantIds.map((id) => [id, g.id])),
  );
  const sections = groups.map((group) => ({ group, agents: [] }));
  const byId = new Map(sections.map((section) => [section.group.id, section]));
  const ungrouped = { group: null, agents: [] };
  for (const agent of agents) {
    const root = agent.teamMemberId ? agent.parentAssistantId : agent.id;
    (byId.get(membership.get(root)) || ungrouped).agents.push(agent);
  }
  return [...sections, ungrouped];
}
// The overview's sections: the owner's order (agent-order.js) within each group, each
// agent with its permanent members under it. A member whose lead is not listed (it is
// archived) is an agent of its own.
export function overviewSections(lists, groups, order) {
  const all = ownerSorted([...lists.own, ...lists.ofUsers], order);
  return areaSections(all, groups).map((section) => {
    const ids = new Set(section.agents.map((a) => a.id));
    return {
      ...section,
      agents: section.agents.filter(
        (a) => !a.teamMemberId || !ids.has(a.parentAssistantId),
      ),
      members: (root) =>
        section.agents.filter((a) => a.teamMemberId && a.parentAssistantId === root.id),
    };
  });
}

// A folded area reports attention in its roots AND their hidden team members.
export function areaStatus(roots, assistants, activity = {}) {
  const ids = new Set(roots.flatMap((a) => [a.id, a.parentAssistantId].filter(Boolean)));
  const entries = assistants
    .filter((a) => !a.archivedAt && (ids.has(a.id) || ids.has(a.parentAssistantId)))
    .map((a) => activity[a.id])
    .filter(Boolean);
  if (
    entries.some(
      (a) =>
        a.pendingApprovals > 0 ||
        ["waiting", "attention"].includes(a.state) ||
        a.team === "awaiting",
    )
  )
    return "attention";
  return entries.some((a) => a.state === "working" || a.team === "working")
    ? "working"
    : null;
}
