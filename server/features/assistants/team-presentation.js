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

// The lead's own section in a member's instructions (member-edits.js).
export const extraStart = "[Additional instructions from your lead]";
export const extraEnd = "[End of additional instructions from your lead]";
export const extraSection = (text) => `\n\n${extraStart}\n${text}\n${extraEnd}`;

// A member made from an Agency template gets the template's instructions instead of
// its lead's (team-templates.js).
export function memberInstructions(snapshot, member) {
  return `${member.templateInstructions ?? snapshot.instructions}\n\nRole: ${member.role}\nAssignment: ${member.assignment}${
    member.extraInstructions ? extraSection(member.extraInstructions) : ""
  }`;
}

/**
 * The instructions the lead last wrote for a member: what it composed at creation,
 * or what its last edit made of the instructions then (member-edits.js). Anything
 * else is the owner's own edit.
 */
export const leadInstructions = (member) =>
  member.leadInstructions ?? memberInstructions(member.snapshot, member);

// A temporary member follows its lead's model, so only a permanent member's model can
// differ from the one it took over (at creation, or when it was kept as permanent).
export function memberOverrides(member, assistant) {
  if (!member.snapshot) return undefined;
  const instructions = assistant.instructions !== leadInstructions(member);
  if (temporaryMember(assistant)) return { instructions };
  return {
    model:
      assistant.model.connectionId !== member.snapshot.model.connectionId ||
      assistant.model.modelId !== member.snapshot.model.modelId,
    instructions,
  };
}

// Temporary team members are not the owner's agents; counts name them apart.
export const temporaryMember = (profile) =>
  !!profile.teamMemberId && profile.lifetime !== "permanent";

/**
 * The model an agent runs on. A temporary member always uses its lead's current model;
 * a permanent member and any other agent use their own. Without a readable lead the
 * member keeps the model it was created with.
 */
export function effectiveModel(assistant, lead) {
  return temporaryMember(assistant) && lead?.model ? { ...lead.model } : assistant.model;
}
