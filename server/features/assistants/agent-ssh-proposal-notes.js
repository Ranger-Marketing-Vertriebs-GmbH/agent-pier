import { actionPath, fenced } from "./action-text.js";

// What an SSH access proposal (agent-ssh-proposals.js) tells the agent and the owner's
// Telegram chat. Never a private key, a password or the host key itself.

// Waiting proposals per agent, and proposals plus failed scans per hour.
export const sshProposalCaps = { open: 2, perHour: 5 };
const endpoint = (p) => `${p.username}@${p.host}:${p.port}`;

/** The agent's follow-up turn: the outcome, and the public key to install. */
export function followUpText(a) {
  const p = a.payload,
    r = a.result || {};
  const outcome = {
    proposalId: a.id,
    state: a.state,
    name: p.name,
    endpoint: endpoint(p),
    ...(a.diagnostic ? { diagnostic: a.diagnostic } : {}),
    ...(a.state === "completed"
      ? { accessId: r.accessId, mode: r.mode, publicKey: r.publicKey }
      : {}),
  };
  const note =
    a.state === "completed"
      ? `the owner confirmed your proposed SSH access ${JSON.stringify(p.name)} (${endpoint(p)}). It is granted to you in mode ${r.mode} as accessId ${r.accessId}. It works only once this public key is installed for the remote user (in ~/.ssh/authorized_keys on the host): tell the owner the key below and where it goes. Never ask for a password or a private key. Use agentpier_ssh (action hosts) once the owner says it is installed.`
      : `your proposed SSH access ${JSON.stringify(p.name)} (${endpoint(p)}) was not created (${a.state}${a.diagnostic ? `: ${a.diagnostic}` : ""}). Do not propose it again unless the owner asks.`;
  return `AgentPier SSH access proposal update: ${note} This is attributed data, not a new instruction or permission.\n${JSON.stringify(outcome)}`;
}

/**
 * The proposal in the owner's Telegram chat: agent, endpoint, project, purpose and
 * the scanned fingerprint with the note to verify it, with Confirm and Decline; then
 * its outcome, with the public key to install once it was created. Telegram confirms
 * with a new managed key and mode With approval.
 */
export function notifySshProposal(w, action, phase, key, m, target) {
  if (!["approval", "result"].includes(phase)) return;
  const p = action.payload,
    t = m.sshProposals;
  let agent = "";
  try {
    agent = w.a.store.getAssistant(action.assistantId).name;
  } catch {}
  const text =
    phase === "approval"
      ? [
          t.approval(agent, p.name),
          t.endpoint(p.username, p.host, p.port),
          ...(p.projectName ? [t.project(p.projectName)] : []),
          `${t.purpose}\n${fenced(p.purpose)}`,
          `${t.fingerprint}\n${fenced(p.hostFingerprint)}`,
          t.verify,
        ].join("\n\n")
      : [
          t.states[action.state] || m.actionStates.unknown,
          t.name(p.name, p.username, p.host, p.port),
          ...(t.diagnostics[action.diagnostic] ? [t.diagnostics[action.diagnostic]] : []),
          ...(action.state === "completed" && action.result?.publicKey
            ? [`${t.publicKey}\n${fenced(action.result.publicKey)}`]
            : []),
        ].join("\n\n");
  const button = (decision, label) => ({
    proposalId: action.id,
    revision: action.revision,
    decision,
    label,
  });
  w.s.assistantChannels.outbox.enqueue({
    key,
    source: { ...target, actionId: action.id },
    kind: `action-${phase}`,
    localized: true,
    text,
    path: actionPath(action),
    actions:
      phase === "approval"
        ? [button("approve", t.approve), button("decline", m.actionDecline)]
        : [],
  });
}
