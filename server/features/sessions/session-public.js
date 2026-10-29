// A session record as the browser sees it. The SSH agent's socket token (also a
// retired one) and the OpenSSH binary paths stay on the server (R30); the UI learns
// only whether the session has an agent.
export function publicSession(session) {
  if (
    !session ||
    typeof session !== "object" ||
    !("sshAgent" in session || "sshAgentRetired" in session)
  )
    return session;
  const { sshAgent, sshAgentRetired: _retired, ...rest } = session;
  return sshAgent === undefined
    ? rest
    : { ...rest, sshAgent: { enabled: sshAgent?.enabled === true } };
}
