import { telegramMessages } from "../assistant-channels/telegram-messages.js";
import { allowAlwaysByAgentPier, execPlan } from "./exec-decisions.js";
import { actionPath, fenced } from "./action-text.js";
import { notifySsh } from "./agent-ssh-notifications.js";
import { commandPreview } from "./agent-ssh-text.js";
import { grantNotes, notifyMemberGrant } from "./member-grant-notes.js";
// The Telegram chat bound to an action: its own Telegram origin, or for a team
// member's request the owner chat recorded when the request was made.
export function telegramTarget(action) {
  return action.origin.kind === "telegram" ? action.origin : action.telegram || null;
}
export function notifyAction(w, action, phase) {
  const target = telegramTarget(action);
  if (!target) return;
  const { outbox, store } = w.s.assistantChannels;
  const key = `action-${phase}:${action.id}`;
  if (outbox.all(target.channelId).some((e) => e.key === key)) return;
  const m = telegramMessages(store.get(target.channelId));
  if (action.payload.action === "exec") return notifyExec(w, action, phase, key, m);
  if (action.payload.action === "ssh") return notifySsh(w, action, phase, key, m, target);
  if (action.payload.action === "member_grant")
    return notifyMemberGrant(w, action, phase, key, m, target);
  const detail =
    (action.requestedBy ? `${m.actionRequestedByMember(action.memberName)}\n` : "") +
    (action.payload.action === "coding_start"
      ? `${action.projectName} · ${action.pipelineName}\n${action.payload.task}${action.payload.baseBranch ? `\n${action.payload.baseBranch}` : ""}`
      : `${action.projectName}\n${action.payload.title}\n\n${action.payload.content}`);
  const text =
    phase === "approval"
      ? `${m.actionApproval}\n\n${detail}`
      : `${phase === "human" ? m.actionHumanReview : m.actionStates[action.state] || m.actionStates.unknown}\n\n${detail.slice(0, 2000)}${action.run?.url ? `\n\n${action.run.url}` : ""}`;
  outbox.enqueue({
    key,
    source: { ...target, actionId: action.id },
    kind: `action-${phase}`,
    localized: true,
    text,
    path: actionPath(action),
    actions:
      phase === "approval"
        ? [
            {
              proposalId: action.id,
              revision: action.revision,
              decision: "approve",
              label: m.actionApprove,
            },
            {
              proposalId: action.id,
              revision: action.revision,
              decision: "decline",
              label: m.actionDecline,
            },
          ]
        : [],
  });
}
const commandLimit = 1500;
// A model-chosen name as inline code: inside it the Markdown renderer escapes
// everything and makes no links. A backtick, which would end it, becomes a
// look-alike, and line breaks become spaces.
const literal = (text) =>
  `\`${String(text)
    .replaceAll("`", "\u02cb")
    .replace(/[\r\n]+/g, " ")}\``;
const programs = (paths) => paths.map(literal).join(", ");
const onceReason = (m, reason, program) =>
  program && m.execOnceReasons[reason]
    ? m.execOnceReasons[reason](literal(program))
    : m.execOnceCommandReasons[reason] || m.execOnceCommandReasons.unresolved;
// The programs an entry allows, and those of them the owner can change.
const programNotes = (paths, writable, allowed, m) => [
  allowed(programs(paths)),
  ...(writable?.length ? [m.execWritablePrograms(programs(writable))] : []),
];
// What "Always allow" will do when OpenClaw withheld it: exactly the stored plan.
function execAllowAlwaysNote(p, m) {
  if (!allowAlwaysByAgentPier(p)) return [];
  const plan = execPlan(p);
  return plan.kind === "paths"
    ? [programNotes(plan.paths, plan.writable, m.execAllowAlwaysPrograms, m).join(" ")]
    : [m.execAllowAlwaysOnce(onceReason(m, plan.reason, plan.program))];
}
// The decision that took effect: a withheld allow-always without an entry ran once.
function execOutcome(action, m) {
  if (action.state !== "completed")
    return m.execStates[action.state] || m.execStates.unknown;
  const allowlist = action.result?.allowlist;
  const decision =
    allowlist && !allowlist.written ? "allow-once" : action.result?.decision;
  return m.execDecided[decision] || m.execDecided["allow-once"];
}
function execAllowlistNote(action, m) {
  const allowlist = action.result?.allowlist;
  if (!allowlist) return [];
  if (allowlist.written) {
    const paths = allowlist.entries.map((e) => e.pattern);
    return [
      programNotes(paths, allowlist.writable, m.execAllowlistPrograms, m).join(" "),
    ];
  }
  if (allowlist.skipped)
    return [m.execAllowlistSkipped(onceReason(m, allowlist.skipped, allowlist.program))];
  return [m.execAllowlistFailed];
}
// The Telegram channel answers only its paired private chat, so the command is
// shown to the owner alone.
function notifyExec(w, action, phase, key, m) {
  const p = action.payload,
    target = telegramTarget(action);
  let name = p.agentId;
  try {
    name = w.a.store.getAssistant(action.assistantId).name;
  } catch {}
  // Truncated by code point, so a surrogate pair is never split.
  const points = Array.from(p.command);
  const command =
    points.length > commandLimit
      ? `${points.slice(0, commandLimit).join("")}…`
      : p.command;
  const detail = [
    m.execAgent(name),
    ...(p.cwd ? [`${m.execCwd}\n${fenced(p.cwd)}`] : []),
    fenced(command),
  ].join("\n");
  const text =
    phase === "approval"
      ? [
          m.execApproval,
          detail,
          ...(p.warningText ? [fenced(p.warningText)] : []),
          ...execAllowAlwaysNote(p, m),
        ].join("\n\n")
      : [execOutcome(action, m), ...execAllowlistNote(action, m), detail].join("\n\n");
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
    // allow-always is always offered; when OpenClaw withholds it, AgentPier
    // writes program entries or allows once (exec-allowlist-policy.js).
    actions:
      phase === "approval"
        ? [
            button("allow-once", m.execAllowOnce),
            ...(p.onceOnly ? [] : [button("allow-always", m.execAllowAlways)]),
            button("deny", m.execDeny),
          ]
        : [],
  });
}
export function actionApprovals(w, entry, notifications) {
  return w.store
    .list()
    .filter(
      (a) =>
        a.attemptId === entry.attemptId &&
        a.conversationId === entry.conversationId &&
        a.origin.kind === "telegram" &&
        ["channelId", "chatId", "userId"].every((k) => a.origin[k] === entry[k]),
    )
    .flatMap((a) => {
      const n = notifications.find(
        (n) =>
          n.key === `action-approval:${a.id}` &&
          n.chatId === entry.chatId &&
          n.userId === entry.userId,
      );
      return n ? [n] : a.state === "awaiting_approval" ? [null] : [];
    });
}
// Records once when an agent-requested coding run started and when it ended, so
// the agent's own chat shows the outcome as an event note next to the turns
// (also for a team member's run, in the parent chat). Returns the action.
const runEnded = new Set(["completed", "failed", "cancelled"]);
export function noteCodingRun(w, a) {
  if (a.payload.action !== "coding_start") return a;
  const phase =
    runEnded.has(a.state) && (a.runId || a.state === "failed")
      ? "result"
      : a.state === "running" && a.runId
        ? "started"
        : null;
  if (!phase || a.chatNotes?.[phase]) return a;
  return w.store.patch(a.id, {
    chatNotes: { ...a.chatNotes, [phase]: { at: w.now(), state: a.state } },
  });
}
// What an SSH run ended with, for its note (web/features/assistants/ssh-run-note.js).
const sshOutcome = (r = {}, diagnostic) =>
  r.reason === "revoked" || diagnostic === "SSH_REVOKED"
    ? "revoked"
    : r.timedOut
      ? "timedOut"
      : r.truncated
        ? "truncated"
        : r.exitCode === 0
          ? "done"
          : "exit";
function sshNotes(a) {
  if (!a.chatNotes.result) return [];
  const r = a.result || {},
    outcome = sshOutcome(r, a.diagnostic);
  return [
    {
      id: `ssh-run:${a.id}`,
      role: "event",
      event: "ssh-run",
      hostName: a.payload.hostName,
      commandPreview: a.payload.commandPreview ?? commandPreview(a.payload.command || ""),
      outcome,
      ...(outcome === "exit" ? { exitCode: r.exitCode ?? r.signal ?? null } : {}),
      durationMs: r.durationMs ?? null,
      timestamp: a.chatNotes.result.at,
      runId: null,
      ...(a.memberName ? { memberName: a.memberName } : {}),
    },
  ];
}
const codingNotes = (a) =>
  ["started", "result"]
    .filter((phase) => a.chatNotes[phase])
    .map((phase) => ({
      id: `coding-run:${a.id}:${phase}`,
      role: "event",
      event: "coding-run",
      phase,
      state: a.chatNotes[phase].state,
      timestamp: a.chatNotes[phase].at,
      runId: a.runId || null,
      projectName: a.projectName || null,
      pipelineName: a.pipelineName || null,
      ...(a.memberName ? { memberName: a.memberName } : {}),
    }));
// The event notes of a conversation's coding runs and SSH runs, oldest first.
export function actionNotes(actions, conversationId) {
  return actions
    .filter((a) => a.conversationId === conversationId && a.chatNotes)
    .flatMap((a) =>
      a.payload.action === "ssh"
        ? sshNotes(a)
        : ["member_grant", "member_reminder", "member_update"].includes(a.payload.action)
          ? grantNotes(a)
          : codingNotes(a),
    )
    .sort((x, y) => x.timestamp - y.timestamp);
}
