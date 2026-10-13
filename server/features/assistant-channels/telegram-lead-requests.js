import { telegramMessages } from "./telegram-messages.js";
// A lead's questions and tasks for its members that came from the owner's Telegram
// chat: an approval request gets buttons there, and the lead's follow-up turn with
// the member's answer or result goes back there once it completes.
const terminal = new Set(["completed", "failed", "cancelled", "declined"]);
const requestPath = (r) =>
  `/agents/${encodeURIComponent(r.parentAssistantId)}/settings?tab=work`;
const telegramOrigin = (r) => r.origin?.kind === "telegram" && !r.origin.forwarded;

/** Open or not yet reported Telegram requests keep the channel's worker busy. */
export function leadRequestWork(outbox, channelId) {
  const requests = outbox.service.assistants.teams?.requests?.store.list() || [];
  return requests.some(
    (r) =>
      telegramOrigin(r) &&
      r.origin.channelId === channelId &&
      (!terminal.has(r.phase) ||
        (r.delivery === "sent" && !outbox.transferred(`request-result:${r.id}`))),
  );
}

export async function transferLeadRequests(outbox) {
  const requests = outbox.service.assistants.teams?.requests?.store;
  if (!requests) return;
  for (const r of requests.list()) {
    if (!telegramOrigin(r)) continue;
    try {
      await transferRequest(outbox, r);
      outbox.recovered(r.id);
    } catch {
      outbox.failed(r.id, r.origin.channelId);
    }
  }
}

async function transferRequest(outbox, r) {
  const { assistants: a, outbox: queue } = outbox.service;
  const source = {
    channelId: r.origin.channelId,
    chatId: r.origin.chatId,
    userId: r.origin.userId,
  };
  const msg = telegramMessages(outbox.service.store.get(source.channelId));
  if (
    r.phase === "awaiting_approval" &&
    !outbox.transferred(`request-approval:${r.id}`)
  ) {
    const key = `lead-request-approval:${r.id}`;
    // A notice enqueued before a crash is reused even if the request changed since.
    const entry =
      queue.all(source.channelId).find((e) => e.key === key) ||
      queue.enqueue({
        key,
        source,
        kind: "lead-request-approval",
        path: requestPath(r),
        localized: true,
        text: approvalText(msg, r, outbox.service.assistants.teams.requests.power(r)),
        actions: ["approve", "decline"].map((decision) => ({
          decision,
          label:
            decision === "approve" ? msg.memberRequestApprove : msg.memberRequestDecline,
          proposalId: r.id,
          revision: r.revision,
        })),
      });
    outbox.recordTransfer(`request-approval:${r.id}`, entry.id);
  }
  if (!r.resultAttemptId || outbox.transferred(`request-result:${r.id}`)) return;
  const attempt = a.ledger.getAttempt(r.resultAttemptId);
  if (
    !["completed", "failed", "cancelled"].includes(attempt.state) &&
    !attempt.reviewedAt
  )
    return;
  let text;
  if (attempt.state === "completed") {
    const history = await a.history(r.parentConversationId);
    if (history.stale) return;
    text = history.messages
      .filter(
        (m) =>
          m.role === "assistant" && [attempt.id, attempt.runtimeRunId].includes(m.runId),
      )
      .at(-1)?.text;
  }
  if (!text?.trim())
    text = [msg.memberRequestNoReply(r.memberName), r.answer || ""]
      .filter(Boolean)
      .join("\n\n");
  const key = `lead-request-result:${r.id}`;
  const entry =
    queue.all(source.channelId).find((e) => e.key === key) ||
    queue.enqueue({
      key,
      source,
      kind: "lead-request-result",
      path: requestPath(r),
      localized: true,
      text: text.slice(0, 65536),
    });
  outbox.recordTransfer(`request-result:${r.id}`, entry.id);
}

/** An approval notice whose request was decided or changed is never sent. */
export function staleRequestApproval(service, entry) {
  if (entry.kind !== "lead-request-approval") return false;
  const r = service.assistants.teams?.requests?.store.teams.find(
    entry.actions[0]?.proposalId,
  );
  return (
    !r ||
    r.phase !== "awaiting_approval" ||
    r.revision !== entry.actions[0].revision ||
    entry.actions[0].expiresAt < Date.now()
  );
}

// The request plus what approving it hands over: the member's shell level, its MCP
// servers and, for a task, that it may change files in its own workspace.
function approvalText(msg, r, power) {
  const servers = power.mcpServers;
  return [
    msg.memberRequestApproval(r.leadName, r.memberName, r.type, r.text),
    [
      msg.memberRequestShell(power.shell),
      servers === null
        ? msg.teamMcpUnavailable
        : servers.length
          ? msg.teamMcpServers(
              servers
                .map((s) => (s.stdio ? msg.teamMcpStdio(s.name) : s.name))
                .join(", "),
            )
          : msg.memberRequestNoMcp,
      ...(r.type === "task"
        ? [
            power.files
              ? msg.memberRequestWrites(r.memberName)
              : msg.memberRequestReadOnly(r.memberName),
          ]
        : []),
    ].join("\n"),
  ].join("\n\n");
}
