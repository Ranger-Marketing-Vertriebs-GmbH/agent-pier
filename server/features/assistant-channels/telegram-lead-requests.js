import { telegramMessages } from "./telegram-messages.js";
import {
  boundedText,
  completeMessage,
  historyTextLimit,
  withNote,
} from "../assistants/history-text.js";
// A lead's questions and tasks for its members that came from the owner's Telegram
// chat: the lead's follow-up turn with the member's answer or result goes back
// there once it completes.
const terminal = new Set(["completed", "failed", "cancelled"]);
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
    const message = history.messages
      .filter(
        (m) =>
          m.role === "assistant" && [attempt.id, attempt.runtimeRunId].includes(m.runId),
      )
      .at(-1);
    // The history page cuts long replies; this one is read on its own. Unlike a
    // direct reply it is one outbox notice, bounded by the outbox's 65536.
    const reply = boundedText(await completeMessage(a, r.parentConversationId, message));
    text = reply.cut ? withNote(reply.text, msg.telegramReplyIncomplete) : reply.text;
  }
  if (!text?.trim()) {
    text = [msg.memberRequestNoReply(r.memberName), r.answer || ""]
      .filter(Boolean)
      .join("\n\n");
    // A member's answer may itself fill the history limit.
    if (r.answerCut || text.length > historyTextLimit)
      text = withNote(text, msg.telegramReplyIncomplete);
  }
  const key = `lead-request-result:${r.id}`;
  const entry =
    queue.all(source.channelId).find((e) => e.key === key) ||
    queue.enqueue({
      key,
      source,
      kind: "lead-request-result",
      path: requestPath(r),
      localized: true,
      text,
    });
  outbox.recordTransfer(`request-result:${r.id}`, entry.id);
}
