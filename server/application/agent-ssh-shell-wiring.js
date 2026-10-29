// Connects the agents' SSH agents (agent-ssh-shell.js) to a constructed assistant
// graph, like connectAgentSecrets: agent changes (AssistantService events) and SSH
// catalog publications refresh every agent's socket and files; each turn syncs its
// own agent first, bounded, and then reads the agent's exec PATH entry and its
// trusted hosts' aliases (assistant-config.js); approvals and agentpier_ssh read the
// one instance as `workflows.agentSsh`; each agent's change signals its live topic.
// Shutdown (`close`) keeps folders and tokens; switching the feature off
// (`discardAll`) removes them; both detach the hooks and listeners first.
import { AgentShellSsh } from "../features/assistants/agent-ssh-shell.js";
import { agentSshChanged } from "../features/assistants/live-topics.js";

/** How long a turn waits for its agent's sync before it reads the status anyway. */
export const turnSyncMs = 2000;
/** How long the first Gateway start waits for the first refresh. */
export const startRefreshMs = 5000;

/** Resolves once `promise` settles or after `ms`, whichever is first; never rejects. */
export function within(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The agent SSH agents of `graph`, or null without the SSH services (`services`:
 * `sshAgentRegistry`, `sshManagement`, `sshAgentsRestored`) or the agent workflows.
 */
export function connectAgentShellSsh(services, graph, { syncMs = turnSyncMs } = {}) {
  const { assistants, assistantWorkflows: workflows } = graph;
  const { sshAgentRegistry: registry, sshManagement } = services;
  if (!registry || !sshManagement?.catalog || !workflows?.access || !assistants?.events)
    return null;
  const { store } = assistants;
  const unsubscribe = [];
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
    // Shutdown and switch-off: hooks and listeners go before the sockets.
    onClose: () => {
      for (const stop of unsubscribe.splice(0)) stop();
      delete assistants.config.plainSsh;
      delete assistants.config.sshShellPath;
      if (workflows.agentSsh === shell) delete workflows.agentSsh;
    },
  });
  const refresh = () => {
    shell.refresh().catch(() => {});
  };
  unsubscribe.push(
    assistants.events.subscribe(refresh),
    sshManagement.catalog.onPublished(refresh),
    // Each agent's change reaches its live topic `agent.ssh-agent:<id>`.
    registry.listen("agent", (id) => agentSshChanged(services.live, id)),
  );
  // Catalog names by access id; the alias names a host the catalog cannot be read for.
  const hostNames = () => {
    try {
      return new Map(sshManagement.store.list().map((h) => [h.id, h.name]));
    } catch {
      return new Map();
    }
  };
  // The exec PATH entry while the agent has a socket; read on every apply.
  assistants.config.sshShellPath = (assistant) => shell.shellPath(assistant);
  // Before each turn: this agent's sync, waited for at most `syncMs` (a busy or stuck
  // queue costs this turn its aliases, never the turn), then its trusted hosts'
  // aliases by catalog name, or null.
  assistants.config.plainSsh = async (assistant) => {
    try {
      await within(shell.sync(assistant.id), syncMs);
      const status = shell.status(assistant.id);
      if (status.state !== "ready") return null;
      const names = hostNames();
      const hosts = Object.entries(status.aliases).map(([accessId, alias]) => ({
        name: names.get(accessId) ?? alias,
        alias,
      }));
      return hosts.length ? { hosts } : null;
    } catch {
      return null;
    }
  };
  workflows.agentSsh = shell;
  return shell;
}
