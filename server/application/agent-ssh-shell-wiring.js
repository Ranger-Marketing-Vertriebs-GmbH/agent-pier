// Connects the agents' SSH agents (agent-ssh-shell.js) to a constructed assistant
// graph, like connectAgentSecrets: agent changes (AssistantService events) and SSH
// catalog publications refresh every agent's socket and files; each turn syncs
// first and then reads the agent's exec PATH entry and its trusted hosts' aliases
// (assistant-config.js); approvals and agentpier_ssh read the one instance as
// `workflows.agentSsh`. Shutdown (`close`) keeps folders and tokens; switching the
// feature off (`discardAll`) removes them.
import { AgentShellSsh } from "../features/assistants/agent-ssh-shell.js";

/**
 * The agent SSH agents of `graph`, or null without the SSH services (`services`:
 * `sshAgentRegistry`, `sshManagement`, `sshAgentsRestored`) or the agent workflows.
 */
export function connectAgentShellSsh(services, graph) {
  const { assistants, assistantWorkflows: workflows } = graph;
  const { sshAgentRegistry: registry, sshManagement } = services;
  if (!registry || !sshManagement?.catalog || !workflows?.access || !assistants?.events)
    return null;
  const { store } = assistants;
  const shell = new AgentShellSsh({
    registry,
    agents: {
      list: () => store.listAssistants(),
      get: (id) => store.getAssistant(id),
    },
    store: sshManagement.store,
    access: workflows.access,
    maintenance: () => !!assistants.maintenance,
    // Every session's token is known before an agent picks one.
    restored: services.sshAgentsRestored,
  });
  const refresh = () => {
    shell.refresh().catch(() => {});
  };
  const unsubscribe = [
    assistants.events.subscribe(refresh),
    sshManagement.catalog.onPublished(refresh),
  ];
  const hostNames = () => {
    try {
      return new Map(sshManagement.store.list().map((h) => [h.id, h.name]));
    } catch {
      return new Map();
    }
  };
  // The exec PATH entry while the agent has a socket; read on every apply.
  assistants.config.sshShellPath = (assistant) => shell.shellPath(assistant);
  // Before each turn: sync, then the trusted hosts' aliases by catalog name, or null.
  assistants.config.plainSsh = async (assistant) => {
    try {
      await shell.refresh();
      const status = shell.status(assistant.id);
      if (status.state !== "ready") return null;
      const names = hostNames();
      const hosts = Object.entries(status.aliases)
        .filter(([accessId]) => names.has(accessId))
        .map(([accessId, alias]) => ({ name: names.get(accessId), alias }));
      return hosts.length ? { hosts } : null;
    } catch {
      return null;
    }
  };
  workflows.agentSsh = shell;
  const detach = () => {
    for (const stop of unsubscribe) stop();
    delete assistants.config.plainSsh;
    delete assistants.config.sshShellPath;
    if (workflows.agentSsh === shell) delete workflows.agentSsh;
  };
  const close = shell.close.bind(shell);
  const discardAll = shell.discardAll.bind(shell);
  shell.close = async () => {
    detach();
    await close();
  };
  shell.discardAll = async () => {
    detach();
    await discardAll();
  };
  return shell;
}
