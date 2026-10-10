const terminal = new Set(["completed", "failed", "cancelled"]);

// Presentation only: admission, recovery and archival keep their durable phases.
export function teamStatus(team, members) {
  if (!members.length) return team.phase;
  if (members.every((m) => terminal.has(m.phase))) {
    if (members.every((m) => m.phase === "completed")) return "completed";
    if (members.some((m) => m.phase === "completed")) return "partial";
    return members.some((m) => m.phase === "failed") ? "failed" : "cancelled";
  }
  if (members.some((m) => ["uncertain", "provisioning_uncertain"].includes(m.phase)))
    return "uncertain";
  if (
    members.some(
      (m) => m.phase === "stopping" || (m.stopRequested && !terminal.has(m.phase)),
    )
  )
    return "stopping";
  return members.every((m) => m.phase === "queued") ? "queued" : "running";
}

export function memberInstructions(snapshot, member) {
  return `${snapshot.instructions}\n\nRole: ${member.role}\nAssignment: ${member.assignment}`;
}

export function memberOverrides(member, assistant) {
  if (!member.snapshot) return undefined;
  return {
    model:
      assistant.model.connectionId !== member.snapshot.model.connectionId ||
      assistant.model.modelId !== member.snapshot.model.modelId,
    instructions: assistant.instructions !== memberInstructions(member.snapshot, member),
  };
}

// Temporary team members are not the owner's agents; counts name them apart.
export const temporaryMember = (profile) =>
  !!profile.teamMemberId && profile.lifetime !== "permanent";
