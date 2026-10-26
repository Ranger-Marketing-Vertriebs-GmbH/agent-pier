import { actionApprovals } from "../assistants/assistant-action-notifications.js";
import { sendTelegramParts } from "./telegram-send-parts.js";
import { telegramParts } from "./telegram-format.js";
import { telegramMessages } from "./telegram-messages.js";
import { completeMessage } from "../assistants/history-text.js";
// History can trail the completion event briefly; after this grace a completed
// run without assistant text is handed to the owner instead of holding the queue.
export const replyGraceMs = 60_000;
// A hard bound against flooding the chat; a reply OpenClaw serves whole (at most
// 65536 characters) normally needs far fewer messages.
export const maxReplyParts = 40;
export class TelegramDelivery {
  constructor(service) {
    this.service = service;
  }
  /**
   * The approval cards of the turn's team proposals and actions (a card not yet
   * queued is null), each with whether it ends the turn (`actionApprovals`). A team
   * proposal always does: the turn proposes it and ends.
   */
  approvals(entry) {
    const { assistants, outbox } = this.service;
    const notifications = outbox.all(entry.channelId);
    const approvals = (assistants.teams?.store.list() || [])
      .filter(
        (team) =>
          team.parentAttemptId === entry.attemptId &&
          team.parentConversationId === entry.conversationId &&
          team.origin?.kind === "telegram" &&
          ["channelId", "chatId", "userId"].every(
            (key) => team.origin[key] === entry[key],
          ),
      )
      .flatMap((team) => {
        const notification = notifications.find(
          (n) =>
            n.kind === "team-approval" &&
            n.teamId === team.id &&
            n.chatId === entry.chatId &&
            n.userId === entry.userId,
        );
        return notification || team.phase === "awaiting_approval"
          ? [{ notification: notification || null, endsTurn: true }]
          : [];
      });
    if (assistants.workflows)
      approvals.push(...actionApprovals(assistants.workflows, entry, notifications));
    return approvals;
  }
  /**
   * Settles a turn whose approval cards are its Telegram reply: once every card was
   * acknowledged (or reviewed), the entry is done with the cards' messages. Waits for
   * them, including across worker restarts.
   */
  settleCards(entry, approvals) {
    const { assistants, ledger } = this.service;
    const cards = approvals.map((a) => a.notification);
    if (!cards.every((n) => n && ["delivered", "reviewed"].includes(n.state))) return;
    ledger.patch(entry.id, {
      state: cards.every((n) => n.state === "delivered") ? "delivered" : "reviewed",
      remoteMessageIds: cards.flatMap((n) => n.remoteMessageIds),
      diagnostic: null,
    });
    assistants.changed({ conversationId: entry.conversationId });
  }
  // Tell the Telegram user once per input that needs the owner in AgentPier
  // (review lane or unknown model outcome). The outbox key makes the notice durable and unique per input.
  announceReview(id) {
    const { store, ledger, assistants } = this.service;
    const channel = store.get(id);
    if (!channel.enabled || !store.secret(id)) return;
    for (const entry of ledger.needsAttention(id)) {
      if (
        entry.reviewNoticeId ||
        entry.chatId !== channel.chatId ||
        entry.userId !== channel.userId
      )
        continue;
      const messages = telegramMessages(channel);
      const notice = this.service.notice(channel, {
        key: `input-review:${entry.id}`,
        kind: "input-review",
        text:
          entry.state === "reply_unavailable"
            ? messages.telegramReplyUnavailable
            : messages.telegramInputNeedsReview,
      });
      ledger.patch(entry.id, { reviewNoticeId: notice.id });
      assistants.changed({ conversationId: entry.conversationId });
    }
  }
  /**
   * A reply's durable parts: all of it, or what OpenClaw serves of a reply too
   * large for it (and at most `maxReplyParts`), closed by a note that the rest
   * was not sent.
   */
  replyParts(channel, { text, cut }) {
    const parts = text.trim() ? telegramParts(text) : [];
    if (!cut && parts.length <= maxReplyParts) return parts;
    return [
      ...parts.slice(0, maxReplyParts),
      ...telegramParts(telegramMessages(channel).telegramReplyIncomplete),
    ];
  }
  async process(id, signal) {
    const { store, ledger, assistants, clientFactory } = this.service;
    const channel = store.get(id),
      token = store.secret(id);
    if (!channel.enabled || !token || signal.aborted) return;
    let entry = ledger.queue(id)[0];
    if (!entry) return;
    if (entry.chatId !== channel.chatId || entry.userId !== channel.userId) {
      ledger.patch(entry.id, {
        state: "delivery_failed",
        diagnostic: "CHANNEL_DESTINATION_CHANGED",
      });
      assistants.changed({ conversationId: entry.conversationId });
      return;
    }
    if (["running", "model_uncertain"].includes(entry.state)) {
      const attempt = assistants.ledger.getAttempt(entry.attemptId);
      if (["failed", "cancelled"].includes(attempt.state)) {
        ledger.patch(entry.id, {
          state: attempt.state,
          diagnostic: "MODEL_REQUEST_FAILED",
        });
        assistants.changed({ conversationId: entry.conversationId });
        return;
      }
      // A reviewed attempt is never polled again, so no late completion can
      // follow: hand the input to the owner and let later inputs proceed.
      if (attempt.reviewedAt && attempt.state !== "completed") {
        ledger.patch(entry.id, {
          state: "model_reviewed",
          diagnostic: "MODEL_OUTCOME_REVIEWED",
        });
        assistants.changed({ conversationId: entry.conversationId });
        return;
      }
      if (["uncertain", "interrupted"].includes(attempt.state)) {
        if (entry.state !== "model_uncertain") {
          ledger.patch(entry.id, {
            state: "model_uncertain",
            diagnostic: "MODEL_OUTCOME_UNKNOWN",
          });
          assistants.changed({ conversationId: entry.conversationId });
        }
        return;
      }
      if (attempt.state !== "completed") return;
      // A card the turn ends with (a proposal, or an action still awaiting the
      // owner) is the turn's reply. When the owner granted every approval while the
      // run waited (exec, SSH, SFTP), the run's own answer follows the cards.
      const approvals = this.approvals(entry);
      if (approvals.some((a) => a.endsTurn)) return this.settleCards(entry, approvals);
      const history = await assistants.history(entry.conversationId);
      if (history.stale || signal.aborted) return;
      const message = history.messages
        .filter(
          (m) =>
            m.role === "assistant" &&
            [attempt.id, attempt.runtimeRunId].filter(Boolean).includes(m.runId),
        )
        .at(-1);
      // A reply too large for the page has no text there but is marked incomplete.
      if (!message?.text?.trim() && message?.cut !== true && message?.partial !== true) {
        const now = this.service.now(),
          since = entry.replyMissingSince ?? now;
        // Without an answer, the decided cards stand in for the reply.
        if (now - since >= replyGraceMs && approvals.length)
          this.settleCards(entry, approvals);
        else if (now - since >= replyGraceMs) {
          ledger.patch(entry.id, {
            state: "reply_unavailable",
            diagnostic: "REPLY_WITHOUT_TEXT",
          });
          assistants.changed({ conversationId: entry.conversationId });
        } else if (entry.replyMissingSince == null)
          ledger.patch(entry.id, {
            diagnostic: "REPLY_UNAVAILABLE",
            replyMissingSince: since,
          });
        return;
      }
      // The history page cuts long replies; this one is read on its own.
      const reply = await completeMessage(assistants, entry.conversationId, message);
      if (signal.aborted) return;
      // The cards' messages belong to the turn too and stay named with the reply.
      const leadMessageIds = approvals.flatMap(
        (a) => a.notification?.remoteMessageIds || [],
      );
      entry = ledger.patch(entry.id, {
        state: "outbound",
        parts: this.replyParts(channel, reply),
        leadMessageIds,
        remoteMessageIds: leadMessageIds,
        nextDeliveryAt: 0,
        diagnostic: null,
      });
    }
    await sendTelegramParts({
      client: clientFactory(token),
      entry,
      save: (patch) => ledger.patch(entry.id, patch),
      signal,
      changed: () => assistants.changed({ conversationId: entry.conversationId }),
    });
  }
}
