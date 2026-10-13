// Derived, never stored: what each agent is doing right now, for the sidebar dot, the
// chat header and the approval count. Labels are copy paths inside assistantCopy so the
// server never holds translations.
const workingAttempts = new Set(["pending", "accepted", "running"]);
const attentionAttempts = new Set(["uncertain", "interrupted"]);
const workingMembers = new Set(["provisioning", "admitting", "running", "stopping"]);
const attentionMembers = new Set(["uncertain", "provisioning_uncertain"]);
export const teamActivePhases = new Set([
  "approved",
  "queued",
  "provisioning",
  "provisioning_uncertain",
  "ready",
  "admitting",
  "running",
  "stopping",
]);
const idle = { state: "idle", reason: null, label: null };

function attemptStates(conversations, latest) {
  const owner = new Map(
    conversations.filter((c) => !c.archivedAt).map((c) => [c.id, c.assistantId]),
  );
  const states = new Map();
  for (const row of latest) {
    const id = owner.get(row.conversationId);
    if (!id || !row.attemptState || row.reviewedAt) continue;
    if (!states.has(id)) states.set(id, []);
    states.get(id).push(row.attemptState);
  }
  return states;
}

function classify({ attempts, member, pendingApprovals, team }) {
  const attention = attempts.find((s) => attentionAttempts.has(s));
  if (attention)
    return { state: "attention", reason: "attempt", label: `status.${attention}` };
  const phase = member?.phase;
  if (attentionMembers.has(phase))
    return { state: "attention", reason: "member", label: `team.states.${phase}` };
  if (pendingApprovals > 0)
    return {
      state: "waiting",
      reason: "approval",
      label:
        team === "awaiting" ? "teamActive.awaiting" : "team.states.awaiting_approval",
    };
  if (attempts.some((s) => workingAttempts.has(s)))
    return { state: "working", reason: "attempt", label: "status.running" };
  if (workingMembers.has(phase))
    return { state: "working", reason: "member", label: `team.states.${phase}` };
  if (phase === "queued")
    return { state: "working", reason: "queued", label: "team.states.queued" };
  if (team === "active")
    return { state: "working", reason: "team", label: "teamActive.working" };
  return idle;
}

const reviewPhases = new Set(["uncertain", "provisioning_uncertain"]);

export function assistantActivity({
  assistants = [],
  conversations = [],
  latest = [],
  awaiting = {},
  teams = [],
  members = [],
}) {
  const attempts = attemptStates(conversations, latest);
  const memberOf = new Map(
    members.filter((m) => !m.archivedAt).map((m) => [m.assistantId, m]),
  );
  const result = {};
  for (const assistant of assistants) {
    if (assistant.archivedAt) continue;
    const own = teams.filter(
      (t) => t.parentAssistantId === assistant.id && !t.archivedAt,
    );
    const proposals = own.filter((t) => t.phase === "awaiting_approval").length;
    const team = proposals
      ? "awaiting"
      : own.some((t) => teamActivePhases.has(t.phase))
        ? "active"
        : null;
    const counts = awaiting[assistant.id] ?? { own: 0, team: 0 };
    // A member whose outcome is unknown holds its team open until the owner reviews
    // it; the lead's chat lists it with the approvals.
    const reviews = members.filter(
      (m) =>
        !m.archivedAt && reviewPhases.has(m.phase) && own.some((t) => t.id === m.teamId),
    ).length;
    const pendingApprovals = counts.own + counts.team + proposals + reviews;
    result[assistant.id] = {
      ...classify({
        attempts: attempts.get(assistant.id) ?? [],
        member: memberOf.get(assistant.id),
        pendingApprovals,
        team,
      }),
      pendingApprovals,
      team,
    };
  }
  return result;
}
