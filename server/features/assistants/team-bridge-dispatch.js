import { invokeDevice } from "./agent-devices.js";
import { invokeHook } from "./agent-hook-proposals.js";
import { invokePreview } from "./agent-previews.js";
import { invokeSshAccess } from "./agent-ssh-proposals.js";
import { peerActions } from "./team-bridge-actions.js";

/**
 * Hands a bridge call that TeamBridge#invoke admitted to the feature behind its
 * action: `invocation` is the call's record of its run (attempt, routine, hook or
 * owner run, team-bridge.js), `input` what the agent passed. Returns the feature's
 * answer, the tool result.
 */
export function dispatch(bridge, action, invocation, input) {
  const { assistants, teams } = bridge;
  const workflows = assistants.workflows;
  if (action === "ssh") return workflows.ssh.invoke(invocation, input);
  if (action === "workspace") return workflows.invoke(invocation, input);
  if (action === "share_file") return assistants.shares.invoke(invocation, input);
  if (action === "pinboard") return assistants.pinboard.invoke(invocation, input);
  if (action === "card") return assistants.cards.invoke(invocation, input);
  if (action === "routine") return assistants.routines.invoke(invocation, input);
  if (action === "hook") return invokeHook(assistants.routines?.hooks, invocation, input);
  if (action === "ssh_access") return invokeSshAccess(workflows, invocation, input);
  if (action === "coding_session") return workflows.sessions.invoke(invocation, input);
  if (action === "mail") return workflows.mail.invoke(invocation, input);
  if (action === "project") return workflows.projects.invoke(invocation, input);
  if (action === "craft") return workflows.craft.invoke(invocation, input);
  if (action === "preview") return invokePreview(workflows, invocation, input);
  if (action === "device") return invokeDevice(workflows, invocation, input);
  if (action === "report") return teams.reports.report(invocation, input);
  if (peerActions.has(action)) return teams.peers[action](invocation, input);
  return action === "reminder"
    ? assistants.reminders.invoke(invocation, input)
    : teams[action](invocation, input);
}
