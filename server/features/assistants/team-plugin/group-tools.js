// A lead's named groups of its permanent members and tasks to a whole group
// (member-groups.js, member-group-tasks.js). The limits match member-groups.js.
const text = (maxLength) => ({ type: "string", minLength: 1, maxLength });
const schema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
export const groupDefinitions = {
  groups: {
    description:
      "Organise your own permanent members into named, lasting groups such as 'Research' or 'Build' (temporary members are never grouped). Actions: list; create (name, at most 60 characters, unique among your groups, at most 20 groups); rename (groupId, name); delete (groupId: its members stay as permanent members without a group); move (memberId, groupId) puts a permanent member into that group at any time, also one created long before or already in another group: it leaves its old group and joins the new one in one step, because a member is in at most one group. ungroup (memberId) takes it out of its group, back to the permanent members without a group. A move never interrupts a task the member is working on; it only decides which later group tasks reach it. An archived member leaves its group; an empty group stays until deleted. Every call returns your groups with their members and the permanent members without a group. The owner sees and can change the same groups. AGENT_LOOP_LIMIT means you started too many such actions in a short time: stop and tell the owner.",
    parameters: schema(
      {
        action: {
          type: "string",
          enum: ["list", "create", "rename", "delete", "move", "ungroup"],
        },
        groupId: text(100),
        memberId: text(100),
        name: text(60),
      },
      ["action"],
    ),
  },
  group_delegate: {
    description:
      "Give one task to every member of one of your groups (from agentpier_team_groups) at once. Each member gets it as its own task, exactly as with agentpier_team_delegate: in its own chat, with its own access and limits, and it may change files only when that member's own task could (the owner's request must name that member, otherwise the part runs read-only unless your 'Your team' instructions say you may delegate on your own). All members get it or none: an empty group (GROUP_EMPTY) or a member that already has an open task (GROUP_MEMBER_BUSY) refuses the whole call. You get no message per member: once every member's part has ended, also when some failed, were cancelled or ran out of time, one follow-up with all results reaches you; then write the owner one short summary. Cancel a single part with agentpier_team_cancel and its requestId. Members moved or archived meanwhile keep the part they were given.",
    parameters: schema(
      {
        groupId: text(100),
        task: text(8192),
        ownerRequested: { type: "boolean" },
        ownerRequestQuote: text(300),
      },
      ["groupId", "task"],
    ),
  },
};
