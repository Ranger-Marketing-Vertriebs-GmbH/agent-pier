import { agentGroupsCopy } from "../../../lib/i18n/messages/agent-groups.js";
export function agentGroupSearchAction(action, parent) {
  return action(
    "new-agent-group",
    () => agentGroupsCopy.newGroup,
    parent,
    { route: { view: "agents" }, pending: "agent-group-add" },
    { agentsOnly: true },
  );
}
