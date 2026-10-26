// Who an SSH bulk action touches, from GET /connections/usage (SshBulkActions.jsx).

/** Agents that hold an own grant of any selected host, from GET /connections/usage. */
export function grantHolders(selected, usage) {
  const holders = new Map();
  for (const access of selected)
    for (const agent of usage?.ssh?.[access.id]?.agents || [])
      if (agent.via === "grant") holders.set(agent.id, agent.name);
  return [...holders].map(([id, name]) => ({ id, name }));
}

/** Who loses a host when it is deleted: agents, hooks and running sessions. */
export function deleteImpact(selected, usage) {
  const entries = selected.map((access) => usage?.ssh?.[access.id] ?? null);
  if (entries.some((entry) => !entry || entry.agents === null || entry.hooks === null))
    return null;
  const agents = new Set();
  const hooks = new Map();
  let sessions = 0;
  let sessionsKnown = true;
  for (const entry of entries) {
    for (const agent of entry.agents) if (agent.via !== "hook") agents.add(agent.name);
    for (const hook of entry.hooks) hooks.set(hook.hookId, hook.name);
    if (entry.sessions === null) sessionsKnown = false;
    else sessions += entry.sessions;
  }
  return {
    agents: [...agents],
    hooks: [...hooks.values()],
    sessions: sessionsKnown ? sessions : null,
  };
}
