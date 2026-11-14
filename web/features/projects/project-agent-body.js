/**
 * The PUT body of one agent's project access (server project-agent-access.js):
 * `expected` is what the page showed, `sessions` and `talk` are compared only when
 * the page knew them. `talk` is sent once the page knows the switch (older servers
 * answer without it) or the owner ticks it, and never without the project grant,
 * which the server would refuse.
 */
export function projectAgentBody(agent, { coding, folder, sessions, talk }) {
  return {
    expected: {
      coding: agent.coding,
      folder: agent.folder,
      ...(agent.sessions !== undefined && { sessions: agent.sessions }),
      ...(agent.talk !== undefined && { talk: agent.talk }),
    },
    coding,
    folder,
    sessions,
    ...((agent.talk !== undefined || talk) && { talk: coding && talk }),
  };
}
