import { telegramMessages } from "../assistant-channels/telegram-messages.js";
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
    path: action.teamId
      ? `/agents/${encodeURIComponent(action.assistantId)}/teams/${encodeURIComponent(action.teamId)}`
      : `/agents/${encodeURIComponent(action.assistantId)}/chats/${encodeURIComponent(action.conversationId)}`,
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
// The event notes of a conversation's coding runs, oldest first.
export function codingRunNotes(actions, conversationId) {
  return actions
    .filter((a) => a.conversationId === conversationId && a.chatNotes)
    .flatMap((a) =>
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
        })),
    )
    .sort((x, y) => x.timestamp - y.timestamp);
}
