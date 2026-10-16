import { actionPath, fenced } from "./action-text.js";
import { hasHiddenCharacters } from "./agent-ssh-text.js";

// Telegram buttons only for commands the owner can read in full there.
export const telegramCommandLimit = 2000;
export const sshTelegramApprovable = (command) =>
  Array.from(String(command)).length <= telegramCommandLimit &&
  !hasHiddenCharacters(command);

function outcome(a, m) {
  if (a.state !== "completed") return m.sshStates[a.state] || m.sshStates.unknown;
  const r = a.result || {};
  return [
    m.sshStates.completed(r.exitCode ?? r.signal ?? "?"),
    ...(r.timedOut ? [m.sshTimedOut] : []),
    ...(r.truncated ? [m.sshTruncated] : []),
  ].join(" · ");
}

/**
 * The approval and its result in the bound chat. The result names the state and the
 * exit code; remote output never goes to Telegram unprompted.
 */
export function notifySsh(w, action, phase, key, m, target) {
  const p = action.payload;
  let agent = action.assistantId;
  try {
    agent = w.a.store.getAssistant(action.assistantId).name;
  } catch {}
  const facts = [
    m.sshAgent(agent),
    ...(action.leadAssistantId ? [m.sshRequestedBy(action.memberName || agent)] : []),
    m.sshTarget(p.hostName, `${p.username}@${p.host}:${p.port}`),
    m.sshTimeout(p.timeoutSeconds),
  ].join("\n");
  const approvable = sshTelegramApprovable(p.command);
  const text =
    phase === "approval"
      ? [m.sshApproval, facts, approvable ? fenced(p.command) : m.sshOpenToApprove].join(
          "\n\n",
        )
      : [outcome(action, m), facts].join("\n\n");
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
      phase === "approval" && approvable
        ? [button("approve", m.sshAllowOnce), button("decline", m.sshDeny)]
        : [],
  });
}
