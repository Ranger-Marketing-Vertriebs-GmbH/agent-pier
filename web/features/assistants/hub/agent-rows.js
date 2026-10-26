// Pure rules of the hub's agent lists (handoff 5.2): which agents each list shows and
// the pills summarising an agent's access and channels.
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";

const permanent = (a) => !a.teamMemberId || a.lifetime === "permanent";

/** Agents of the owner and of users, each without archived ones; temporary members never. */
export function hubLists(assistants = []) {
  const live = assistants.filter((a) => !a.archivedAt && permanent(a));
  return {
    own: live.filter((a) => !a.userAccess),
    ofUsers: live.filter((a) => a.userAccess),
    archived: assistants.filter((a) => a.archivedAt),
  };
}

/**
 * Pills for one agent: granted projects, MCP servers, SSH hosts and a connected
 * Telegram bot. `policy` is its access record (null while unknown: no access pills,
 * never a made-up 0); `telegram` whether a channel exists.
 */
export function agentPills(assistant, policy, telegram) {
  const copy = agentsHubCopy.pills;
  const pills = [];
  if (policy) {
    const projects = assistant.userAccess
      ? Object.keys(policy.projectFiles || {}).length
      : new Set([...(policy.projectIds || []), ...Object.keys(policy.projectFiles || {})])
          .size;
    if (projects) pills.push(copy.projects(projects));
  }
  const mcp = (assistant.mcpServers || []).length;
  if (mcp) pills.push(copy.mcp(mcp));
  if (policy) {
    const ssh = (policy.sshAccesses || []).length;
    if (ssh) pills.push(copy.ssh(ssh));
  }
  if (telegram) pills.push(copy.telegram);
  if (!pills.length && policy && telegram !== null) pills.push(copy.none);
  return pills;
}

/** The tab counts: agents of the owner and users, all teams, catalog entries. */
export function hubCounts({ assistants, teams, templates }) {
  const lists = hubLists(assistants);
  return {
    all: lists.own.length + lists.ofUsers.length,
    teams: (teams || []).filter((t) => !t.archivedAt).length,
    ...(Number.isSafeInteger(templates) ? { templates } : {}),
  };
}
