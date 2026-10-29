/**
 * What GET /sessions/:id/ssh-accesses answers for `session`: the hosts it may use,
 * its assigned and inherited ids, the helper commands and, with the SSH integration,
 * the state of its SSH tools and, with session SSH agents, its agent (state, aliases).
 * `result` (a binding just saved) replaces the read.
 */
export async function sessionSshAccesses(
  { sshSessions, sshIntegration, sshAgents },
  session,
  result,
) {
  return {
    ...(await (result ?? sshSessions.get(session))),
    ...(sshIntegration ? { tools: sshIntegration.status(session) } : {}),
    ...(sshAgents ? { agent: sshAgents.status(session) } : {}),
  };
}
