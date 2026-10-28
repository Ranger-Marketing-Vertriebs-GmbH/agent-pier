/**
 * What GET /sessions/:id/ssh-accesses answers for `session`: the hosts it may use,
 * its assigned and inherited ids, the helper commands and, with the SSH integration,
 * the state of its SSH tools. `result` (a binding just saved) replaces the read.
 */
export async function sessionSshAccesses(
  { sshSessions, sshIntegration },
  session,
  result,
) {
  return {
    ...(await (result ?? sshSessions.get(session))),
    ...(sshIntegration ? { tools: sshIntegration.status(session) } : {}),
  };
}
