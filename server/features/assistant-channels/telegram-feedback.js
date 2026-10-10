const working = new Set([
  "transcribing",
  "dispatching",
  "running",
  "outbound",
  "delivering",
]);
export class TelegramFeedback {
  constructor(service) {
    this.service = service;
    this.nextTypingAt = new Map();
    this.retryAt = new Map();
  }
  async process(id, signal) {
    const { store, ledger, clientFactory } = this.service;
    const channel = store.get(id),
      token = store.secret(id);
    if (
      !channel.enabled ||
      !token ||
      signal.aborted ||
      this.service.closed ||
      Date.now() < (this.retryAt.get(id) || 0)
    )
      return;
    const failed = (error) => {
      if (error.code === "TELEGRAM_RATE_LIMIT")
        this.retryAt.set(
          id,
          Math.max(
            this.retryAt.get(id) || 0,
            Date.now() + Math.max(4, Math.min(error.retryAfter || 30, 3600)) * 1000,
          ),
        );
    };
    const matches = (entry) =>
      entry?.chatId === channel.chatId && entry?.userId === channel.userId;
    const client = clientFactory(token);
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
    const pending = ledger.pendingReceipt(id, channel.chatId, channel.userId);
    const tasks = [];
    if (pending && matches(pending)) {
      // Persist before HTTP: even a lost acknowledgement must not replay the reaction.
      ledger.patch(pending.id, { receipt: "attempted" });
      tasks.push(
        (async () => {
          try {
            const confirmed = await client.call(
              "setMessageReaction",
              {
                chat_id: pending.chatId,
                message_id: pending.messageId,
                reaction: [{ type: "emoji", emoji: "👀" }],
                is_big: false,
              },
              boundedSignal,
            );
            ledger.patch(pending.id, {
              receipt: confirmed === true ? "confirmed" : "unavailable",
            });
          } catch (error) {
            failed(error);
            ledger.patch(pending.id, { receipt: "unavailable" });
          }
        })(),
      );
    }
    const first = ledger.queue(id)[0];
    if (
      matches(first) &&
      working.has(first.state) &&
      (first.state !== "running" ||
        ["pending", "accepted", "running"].includes(
          this.service.assistants.ledger.getAttempt(first.attemptId).state,
        )) &&
      Date.now() >= (this.nextTypingAt.get(id) || 0)
    ) {
      this.nextTypingAt.set(id, Date.now() + 4000);
      tasks.push(
        client
          .call(
            "sendChatAction",
            { chat_id: first.chatId, action: "typing" },
            boundedSignal,
          )
          .catch(failed),
      );
    }
    await Promise.allSettled(tasks);
  }
}
