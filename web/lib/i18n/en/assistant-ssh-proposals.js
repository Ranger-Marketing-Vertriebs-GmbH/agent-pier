// An agent's proposal of a new SSH access, waiting for the owner (agent-ssh-proposals.js).
export const sshProposalCopy = {
  title: "SSH access proposal",
  login: "Login",
  project: "Project",
  noProject: "No project",
  purpose: "Purpose",
  fingerprint: "Host key fingerprint (scanned, not verified)",
  verify:
    "Check this fingerprint against the server through a channel you trust, such as its console, your provider or an administrator. Confirming pins it as verified by you.",
  key: "Key",
  newKey: "New managed key",
  keysFailed:
    "The project's keys could not be loaded. Confirming creates a new managed key.",
  mode: "Mode",
  approve: "Confirm access",
  created: (name) => `SSH access “${name}” created.`,
  installKey:
    "Install this public key for the remote user (in ~/.ssh/authorized_keys) before the agent connects. AgentPier never installs it.",
  history: (name) => `SSH access proposal: ${name}`,
  diagnostics: {
    HOST_KEY_CHANGED:
      "The host presented a different key than the one in the proposal. The agent has to propose the access again.",
    HOST_EXISTS: "This host, port and user are already an SSH access.",
    AGENT_UNAVAILABLE: "The agent can no longer hold SSH accesses.",
  },
};
