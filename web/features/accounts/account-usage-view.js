import { commonCopy } from "../../lib/i18n/messages/common.js";
import { accountsHubCopy } from "../../lib/i18n/messages/accounts.js";

// Same text as ListRow's unknownValue (a JSX module node tests cannot import).
export const unknownUsage = "—";

const unusedUsage = Object.freeze({
  agents: [],
  sessions: 0,
  pipelineProfiles: [],
  clis: [],
});

const groups = {
  connection: "connections",
  chatgpt: "chatgpt",
  "mcp-server": "mcpServers",
  "cli-account": "cliAccounts",
};

/** One entry's usage from GET /accounts/usage; undefined while it is not known. */
export function usageEntry(usage, kind, id) {
  if (!usage || typeof usage !== "object") return undefined;
  if (kind === "speech") return usage.speech ?? undefined;
  if (kind === "web-search") return usage.webSearch ?? undefined;
  if (kind === "pdf-model") return usage.pdfModel ?? undefined;
  const group = usage[groups[kind]];
  if (!group || typeof group !== "object") return undefined;
  // The endpoint lists only ChatGPT accounts an agent's model references; once the
  // list arrived, a missing account is known to be unused (not unknown).
  if (kind === "chatgpt") return group[id] ?? unusedUsage;
  return group[id] ?? undefined;
}

export function usageValue(entry) {
  if (!entry) return unknownUsage;
  const agents = entry.agents?.length ?? 0;
  if (agents) return commonCopy.agentsCount(agents);
  if (entry.sessions > 0) return accountsHubCopy.sessionsOnly;
  return "";
}

const agentTabs = {
  model: "identity",
  capability: "capabilities",
  binding: "access",
  pipelines: "access",
  channel: "channels",
};

/** The agent settings tab where the agent chose this entry. */
export function agentRoute(agent) {
  const tab = agentTabs[agent.via];
  return {
    view: "agents",
    assistantId: agent.id,
    agentSettings: true,
    ...(tab ? { agentTab: tab } : {}),
  };
}

export function restartNote(entry) {
  const count = entry?.agents?.length ?? 0;
  return count ? accountsHubCopy.restartsAgents(count) : "";
}
