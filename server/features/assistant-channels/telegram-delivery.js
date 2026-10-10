import { actionApprovals } from "../assistants/assistant-action-notifications.js";
import { sendTelegramParts } from "./telegram-send-parts.js";
import { telegramParts } from "./telegram-format.js";
import { telegramMessages } from "./telegram-messages.js";
// History can trail the completion event briefly; after this grace a completed
// run without assistant text is handed to the owner instead of holding the queue.
export const replyGraceMs = 60_000;
export class TelegramDelivery {
  constructor(service) {
    this.service = service;
  }
  settleApproval(entry) {
    const { assistants, outbox, ledger } = this.service;
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
        return notification
          ? [notification]
          : team.phase === "awaiting_approval"
            ? [null]
            : [];
      });
    if (assistants.workflows)
      approvals.push(...actionApprovals(assistants.workflows, entry, notifications));
    if (!approvals.length) return false;
    // The durable proposal is this turn's Telegram reply. Wait for its actual
    // acknowledgement (or explicit review), including across worker restarts.
    if (approvals.every((n) => n && ["delivered", "reviewed"].includes(n.state))) {
      ledger.patch(entry.id, {
        state: approvals.every((n) => n.state === "delivered") ? "delivered" : "reviewed",
        remoteMessageIds: approvals.flatMap((n) => n.remoteMessageIds),
        diagnostic: null,
      });
      assistants.changed();
    }
    return true;
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
      assistants.changed();
    }
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
      assistants.changed();
      return;
    }
    if (["running", "model_uncertain"].includes(entry.state)) {
      const attempt = assistants.ledger.getAttempt(entry.attemptId);
      if (["failed", "cancelled"].includes(attempt.state)) {
        ledger.patch(entry.id, {
          state: attempt.state,
          diagnostic: "MODEL_REQUEST_FAILED",
        });
        assistants.changed();
        return;
      }
      // A reviewed attempt is never polled again, so no late completion can
      // follow: hand the input to the owner and let later inputs proceed.
      if (attempt.reviewedAt && attempt.state !== "completed") {
        ledger.patch(entry.id, {
          state: "model_reviewed",
          diagnostic: "MODEL_OUTCOME_REVIEWED",
        });
        assistants.changed();
        return;
      }
      if (["uncertain", "interrupted"].includes(attempt.state)) {
        if (entry.state !== "model_uncertain") {
          ledger.patch(entry.id, {
            state: "model_uncertain",
            diagnostic: "MODEL_OUTCOME_UNKNOWN",
          });
          assistants.changed();
        }
        return;
      }
      if (attempt.state !== "completed") return;
      if (this.settleApproval(entry)) return;
      const history = await assistants.history(entry.conversationId);
      if (history.stale || signal.aborted) return;
      const reply = history.messages
        .filter(
          (m) =>
            m.role === "assistant" &&
            [attempt.id, attempt.runtimeRunId].filter(Boolean).includes(m.runId),
        )
        .at(-1)?.text;
      if (!reply?.trim()) {
        const now = this.service.now(),
          since = entry.replyMissingSince ?? now;
        if (now - since >= replyGraceMs) {
          ledger.patch(entry.id, {
            state: "reply_unavailable",
            diagnostic: "REPLY_WITHOUT_TEXT",
          });
          assistants.changed();
        } else if (entry.replyMissingSince == null)
          ledger.patch(entry.id, {
            diagnostic: "REPLY_UNAVAILABLE",
            replyMissingSince: since,
          });
        return;
      }
      if (reply.length > 65536) {
        ledger.patch(entry.id, {
          state: "delivery_failed",
          diagnostic: "REPLY_TOO_LARGE",
        });
        return;
      }
      entry = ledger.patch(entry.id, {
        state: "outbound",
        parts: telegramParts(reply),
        remoteMessageIds: [],
        nextDeliveryAt: 0,
        diagnostic: null,
      });
    }
    await sendTelegramParts({
      client: clientFactory(token),
      entry,
      save: (patch) => ledger.patch(entry.id, patch),
      signal,
      changed: () => assistants.changed(),
    });
  }
}
