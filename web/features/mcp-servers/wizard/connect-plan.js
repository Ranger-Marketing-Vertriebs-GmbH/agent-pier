import { cliSupport, cliTarget } from "../cli-support.js";

// Connect binds coding CLIs and agents with one consent and reports every target on
// its own; nothing is all-or-nothing across agents (decision Q2). It does not use
// runSaveChain, which stops at the first error.
export const AGENT_GONE = "AGENT_GONE";
export const PACKAGE_NOT_READY = "PACKAGE_NOT_READY";

/** Agents the owner binds servers to; temporary members have no `mcpServers`. */
export const ownerManaged = (assistants = []) =>
  assistants.filter((item) => Array.isArray(item.mcpServers) && !item.archivedAt);

/** What Connect changes about `server` for the chosen CLIs and agent ids. */
export function connectDiff({ server, clis, agents, assistants }) {
  const target = cliTarget(server);
  const wanted = clis.filter((cli) => cliSupport(cli, target).supported);
  const before = server.clis || [];
  const added = wanted.filter((cli) => !before.includes(cli));
  const changed = added.length > 0 || before.some((cli) => !wanted.includes(cli));
  const changes = ownerManaged(assistants).flatMap((item) => {
    const has = item.mcpServers.includes(server.id);
    const want = agents.includes(item.id);
    return has === want ? [] : [{ id: item.id, name: item.name, add: want }];
  });
  const stdio = server.transport === "stdio";
  return {
    clis: { changed, wanted, added },
    agents: changes,
    stdio,
    needsConsent: stdio && (added.length > 0 || changes.some((change) => change.add)),
  };
}

/** The diff reduced to one target, for Try again. */
export const onlyTarget = (diff, target) => ({
  ...diff,
  clis: target.kind === "cli" ? diff.clis : { ...diff.clis, changed: false },
  agents: target.kind === "agent" ? diff.agents.filter((c) => c.id === target.id) : [],
});

/** One failed result per target: nothing was bound (for example the install failed). */
export const notConnected = (diff, code) => [
  ...(diff.clis.changed ? [{ target: { kind: "cli" }, ok: false, error: { code } }] : []),
  ...diff.agents.map((change) => ({
    target: { kind: "agent", id: change.id, name: change.name, add: change.add },
    ok: false,
    error: { code },
  })),
];

const conflict = (error) =>
  error?.status === 409 && error?.messageKey === "assistants.conflict";

async function connectClis({ diff, serverId, consented, api }) {
  const target = { kind: "cli" };
  try {
    // Read now: an install moves the revision after the wizard saved the server.
    const fresh = await api.server(serverId);
    const confirm = consented && diff.stdio && diff.clis.added.length > 0;
    const server = await api.updateServer(serverId, {
      revision: fresh.revision,
      clis: diff.clis.wanted,
      ...(confirm ? { confirmStdio: true } : {}),
    });
    return { target, ok: true, server };
  } catch (error) {
    return { target, ok: false, error };
  }
}

async function connectAgent({ change, serverId, stdio, consented, api, list }) {
  const target = { kind: "agent", id: change.id, name: change.name, add: change.add };
  let agents = list;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      agents ??= ownerManaged(await api.assistants());
      const fresh = agents.find((item) => item.id === change.id);
      if (!fresh)
        return { result: { target, ok: false, error: { code: AGENT_GONE } }, agents };
      if (fresh.mcpServers.includes(serverId) === change.add)
        return { result: { target, ok: true }, agents };
      // Only this server is added or removed: other bindings stay as they are.
      const mcpServers = change.add
        ? [...fresh.mcpServers, serverId]
        : fresh.mcpServers.filter((id) => id !== serverId);
      await api.updateAssistant(change.id, {
        mcpServers,
        revision: fresh.revision,
        ...(stdio && change.add && consented ? { confirmStdio: true } : {}),
      });
      return { result: { target, ok: true }, agents };
    } catch (error) {
      agents = null;
      if (attempt === 0 && conflict(error)) continue;
      return { result: { target, ok: false, error }, agents };
    }
  }
  return { result: { target, ok: false, error: { code: AGENT_GONE } }, agents };
}

/** CLIs first, then one agent after the other; one result per target. */
export async function runConnect({ diff, serverId, consented, api }) {
  const results = [];
  if (diff.clis.changed)
    results.push(await connectClis({ diff, serverId, consented, api }));
  let list = null;
  for (const change of diff.agents) {
    const { result, agents } = await connectAgent({
      change,
      serverId,
      stdio: diff.stdio,
      consented,
      api,
      list,
    });
    list = agents;
    results.push(result);
  }
  return results;
}
