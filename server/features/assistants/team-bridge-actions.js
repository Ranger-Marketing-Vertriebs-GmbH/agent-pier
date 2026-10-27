import { inheritsFromLead, personalCapabilities } from "./native-capabilities.js";

// A member's own tools: its siblings of the same lead, questions and tasks for them
// (peer-requests.js) and reports to its lead (member-reports.js). Leads never reach
// them (TeamBridge.valid).
export const memberActions = new Set(["peers", "peer_ask", "peer_delegate", "report"]);
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
  // A lead's summary of its member's task chat (member-summaries.js).
  "member_summarise",
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
  // A work goal in the owner's chat (work-goals.js); never a routine run.
  "goal",
  // The agent's hook proposals for the owner (agent-hook-proposals.js); owner turns only.
  "hook",
  // The agent's SSH access proposals (agent-ssh-proposals.js); owner turns only.
  "ssh_access",
  // The agent's own coding sessions (coding-sessions/agent-coding-sessions.js).
  "coding_session",
  ...memberActions,
]);
// The tool name behind a bridge action: agentpier_ssh, agentpier_team_<action>, ...
export const bridgeTool = (action) =>
  [
    "reminder",
    "routine",
    "workspace",
    "ssh",
    "share_file",
    "goal",
    "hook",
    "ssh_access",
    "coding_session",
  ].includes(action)
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
  // Coding sessions the routine starts and drives (coding-sessions/session-turns.js).
  "coding_session",
  // A member's routine asks, hands over and reports; a lead's routine is refused by
  // the caller check (peer-request-rules.js peerCaller).
  ...memberActions,
]);
// A member's questions and tasks for its siblings (peer-requests.js).
export const peerActions = new Set(["peers", "peer_ask", "peer_delegate"]);
// A permanent member's own tools, as an own agent's.
export const personalActions = new Set([
  "reminder",
  "routine",
  "ssh",
  "goal",
  "hook",
  "ssh_access",
  "coding_session",
]);
// What a temporary member reaches through its lead: reminders (created on the lead)
// and SSH on the lead's grants, each only while it inherits them right now.
export const inheritedAction = (a, action) =>
  inheritsFromLead(a) &&
  ((action === "reminder" && personalCapabilities(a).reminders) ||
    (action === "ssh" && a.inherited.ssh === true));
