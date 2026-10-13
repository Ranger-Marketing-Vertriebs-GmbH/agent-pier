import { personalCapabilities } from "../assistants/native-capabilities.js";
import { temporaryMember } from "../assistants/team-presentation.js";

// "Used by" for the Accounts page. Agent data is read only while the agents feature
// runs, so the page stays free of agent services when agents are off. A source that
// fails to read becomes null (shown as "—"), never a fake 0 or an empty list.
const entry = (map, id) =>
  typeof id === "string" && Object.hasOwn(map, id) ? map[id] : null;
const safe = (read, empty) => {
  try {
    return read() ?? empty;
  } catch {
    return null;
  }
};

function addAgent(target, profile, via) {
  if (!target?.agents || target.agents.some((a) => a.id === profile.id && a.via === via))
    return;
  target.agents.push({
    id: profile.id,
    name: profile.name,
    kind: temporaryMember(profile) ? "teamMember" : "agent",
    via,
  });
}

export async function usageSources(services) {
  const assistants =
    services.assistantFeature?.enabled && services.assistants
      ? services.assistants
      : null;
  const listed = assistants
    ? safe(
        () => assistants.store.listAssistants().filter((profile) => !profile.archivedAt),
        [],
      )
    : [];
  const agents = listed || [];
  const central = services.mcpServers;
  const bindings = services.assistantMcpServers || central;
  const access = Object.fromEntries(
    agents.map((a) => [a.id, safe(() => assistants.workflows?.access.get(a.id), {})]),
  );
  const agentServers = Object.fromEntries(
    agents.map((a) => [a.id, safe(() => bindings.bindings("agent", a.id), [])]),
  );
  const channels = assistants
    ? safe(() => services.assistantChannels?.store.list(), [])
    : [];
  return {
    agentsEnabled: Boolean(assistants),
    // Agent lists are complete only when every agent read worked.
    agentsKnown:
      listed !== null &&
      channels !== null &&
      [...Object.values(access), ...Object.values(agentServers)].every(
        (value) => value !== null,
      ),
    connections: safe(() => services.providerConnections.list(), []) || [],
    accounts: safe(() => services.accounts.list(), []) || [],
    sessions: services.sessions
      ? await Promise.resolve()
          .then(() => services.sessions.list())
          .then(
            (list) => list ?? [],
            () => null,
          )
      : [],
    profiles: safe(() => services.pipelineDefinitions.listProfiles(), []),
    servers:
      safe(
        () =>
          central.list().map((server) => ({
            id: server.id,
            clis: central.targetsOf(server.id).clis,
          })),
        [],
      ) || [],
    agents,
    access,
    agentServers,
    channels: channels || [],
  };
}

export function summarizeUsage(sources) {
  const agentsKnown = sources.agentsKnown !== false;
  const usage = () => ({
    agents: agentsKnown ? [] : null,
    sessions: sources.sessions ? 0 : null,
    pipelineProfiles: sources.profiles ? [] : null,
    clis: [],
  });
  const connections = Object.fromEntries(
    sources.connections.map((c) => [
      c.id,
      {
        ...usage(),
        clis: (c.tools || []).map((tool) => ({
          tool,
          route: c.toolRoutes?.[tool] ?? null,
        })),
      },
    ]),
  );
  const cliAccounts = Object.fromEntries(sources.accounts.map((a) => [a.id, usage()]));
  const mcpServers = Object.fromEntries(
    sources.servers.map((s) => [
      s.id,
      { ...usage(), clis: s.clis.map((tool) => ({ tool, route: null })) },
    ]),
  );
  const chatgpt = {};
  for (const session of sources.sessions || []) {
    const connection = entry(connections, session.access?.providerConnectionId);
    if (connection) connection.sessions++;
    const account = entry(
      cliAccounts,
      session.access?.sourceAccountId ?? session.accountId,
    );
    if (account) account.sessions++;
  }
  for (const profile of sources.profiles || []) {
    const ref = { id: profile.id, name: profile.name };
    entry(connections, profile.config?.providerConnectionId)?.pipelineProfiles.push(ref);
    entry(cliAccounts, profile.config?.accountId)?.pipelineProfiles.push(ref);
  }
  const webSearch = sources.agentsEnabled ? usage() : null;
  const speech = sources.agentsEnabled ? usage() : null;
  const byId = new Map(sources.agents.map((agent) => [agent.id, agent]));
  for (const agent of sources.agents) {
    const model = agent.model?.connectionId;
    if (typeof model === "string" && model.startsWith("openclaw:"))
      addAgent((chatgpt[model] ||= usage()), agent, "model");
    else addAgent(entry(connections, model), agent, "model");
    const access = sources.access[agent.id];
    for (const id of access?.connectionIds || [])
      addAgent(entry(connections, id), agent, "pipelines");
    for (const id of access?.accountIds || [])
      addAgent(entry(cliAccounts, id), agent, "pipelines");
    for (const id of sources.agentServers[agent.id] || [])
      addAgent(entry(mcpServers, id), agent, "binding");
    if (personalCapabilities(agent).webSearch) addAgent(webSearch, agent, "capability");
  }
  for (const channel of sources.channels) {
    const agent = byId.get(channel.assistantId);
    if (agent) addAgent(speech, agent, "channel");
  }
  return {
    agentsEnabled: sources.agentsEnabled,
    connections,
    chatgpt,
    mcpServers,
    webSearch,
    speech,
    cliAccounts,
  };
}

export const accountUsage = async (services) =>
  summarizeUsage(await usageSources(services));
