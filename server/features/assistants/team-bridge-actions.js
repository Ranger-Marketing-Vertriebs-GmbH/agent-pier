// The actions the team bridge serves (team-bridge.js), with the tool behind each.
export const actions = new Set([
  "propose",
  "status",
  "stop",
  // A lead's questions and tasks for its own members; members never reach these.
  "members",
  "ask",
  "delegate",
  "cancel",
  "archive",
  "grant",
  "member_update",
  "models", // what a lead can give its members (member-models.js)
  // Routines a lead sets up on its own permanent members (lead-routines.js).
  "member_routine",
  "promote",
  "templates", // Agency agents as member templates (team-templates.js)
  "reminder",
  "routine",
  "workspace",
  "ssh",
  // Every agent, members too, hands the owner files (agent-shares.js).
  "share_file",
]);
// The tool name behind a bridge action: agentpier_ssh, agentpier_team_<action>, ...
export const bridgeTool = (action) =>
  ["reminder", "routine", "workspace", "ssh", "share_file"].includes(action)
    ? `agentpier_${action}`
    : `agentpier_team_${action}`;
// What a routine's own run session (no attempt) may call: SSH, shared files, project
// folders, and a lead's questions and tasks for its own members (routine origin,
// lead-request-store.js).
export const routineActions = new Set([
  "ssh",
  "share_file",
  "members",
  "ask",
  "delegate",
  // Project folders and coding requests (workspace-calls.js routineContext).
  "workspace",
]);
