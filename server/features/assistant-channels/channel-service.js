import { ChannelOutbox } from "./channel-outbox.js";
import { TelegramOutbox } from "./telegram-outbox.js";
import { TelegramTeamActions } from "./telegram-team-actions.js";
import { TelegramFeedback } from "./telegram-feedback.js";
import { TelegramDelivery } from "./telegram-delivery.js";
import { SpeechService } from "../speech/speech-service.js";
import { ChannelLedger } from "./channel-ledger.js";
import { TelegramIngress } from "./telegram-ingress.js";
import { ChannelStore, channelLanguage } from "./channel-store.js";
import { TelegramClient } from "./telegram-client.js";
import { assistantProblem } from "../assistants/assistant-validation.js";
import { telegramMessages } from "./telegram-messages.js";
export class ChannelService {
  constructor({
    dataDir,
    assistants,
    speech,
    clientFactory = (token) => new TelegramClient({ token }),
    now = Date.now,
    maxVoiceSeconds = 600,
  }) {
    Object.assign(this, { assistants, speech, clientFactory, now });
    this.store = new ChannelStore({ dataDir });
    this.ledger = new ChannelLedger(this.store.db, { maxVoiceSeconds });
    this.outbox = new ChannelOutbox(this.store.db, {
      link: (channelId, path) => this.link(channelId, path),
    });
    this.teamOutbox = new TelegramOutbox(this);
    this.teamActions = new TelegramTeamActions(this);
    this.speechService = new SpeechService({ connections: speech });
    this.ingress = new TelegramIngress(this);
    this.delivery = new TelegramDelivery(this);
    this.feedback = new TelegramFeedback(this);
    this.feedbackWorkers = new Map();
    this.pollers = new Map();
    this.workers = new Map();
    this.validated = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }
  serialize(operation) {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        if (this.closed) throw assistantProblem("unavailable", 503);
        this.mutating = true;
        try {
          return await operation();
        } finally {
          this.mutating = false;
        }
      });
    this.queue = task;
    return task;
  }
  // Absolute AgentPier link for a notice, or null without a configured address.
  link(channelId, path) {
    const channel = this.store.get(channelId);
    return channel.appUrl
      ? {
          url: `${channel.appUrl}${path}`,
          label: telegramMessages(channel).telegramOpenInAgentPier,
        }
      : null;
  }
  chatPath(channel) {
    return `/agents/${encodeURIComponent(channel.assistantId)}/chats/${encodeURIComponent(channel.conversationId)}`;
  }
  /**
   * One durable notice per key to the paired chat, linking to the channel's
   * conversation. An existing notice is reused, so a later language or address
   * change can never conflict with the stored fingerprint.
   */
  notice(channel, { key, kind, text }) {
    return (
      this.outbox.all(channel.id).find((e) => e.key === key) ||
      this.outbox.enqueue({
        key,
        source: { channelId: channel.id, chatId: channel.chatId, userId: channel.userId },
        kind,
        text,
        path: this.chatPath(channel),
        localized: true,
      })
    );
  }
  list() {
    return {
      channels: this.store.list().map((c) => ({
        ...c,
        notificationDiagnostic: this.teamOutbox.diagnostic(c.id),
        inputs: this.ledger.public(c.id),
        notifications: this.outbox.public(c.id),
      })),
    };
  }
  create(input) {
    return this.serialize(async () => {
      if (
        !input ||
        Object.keys(input).some(
          (k) => !["assistantId", "token", "appUrl", "language"].includes(k),
        )
      )
        throw assistantProblem("invalid");
      channelLanguage(input.language);
      this.assistants.store.getAssistant(input.assistantId);
      const identity = await this.clientFactory(input.token).identity();
      const conversation = await this.assistants.openConversation(input.assistantId);
      const channel = this.store.create({
        assistantId: input.assistantId,
        conversationId: conversation.id,
        botId: identity.id,
        username: identity.username,
        token: input.token,
        appUrl: input.appUrl ?? null,
        language: input.language,
      });
      this.assistants.changed();
      return channel;
    });
  }
  update(id, input) {
    return this.serialize(async () => {
      const { revision, ...patch } = input || {};
      // The AgentPier address and notice language only affect notices enqueued
      // later, so changing them must not abort in-flight deliveries.
      const keys = Object.keys(patch);
      if (!keys.length || !keys.every((k) => ["appUrl", "language"].includes(k)))
        await this.stopChannel(id);
      let result;
      if (Object.keys(patch).length === 1 && typeof patch.token === "string") {
        const current = this.store.requireRevision(id, revision);
        const identity = await this.clientFactory(patch.token).identity();
        if (String(identity.id) !== current.botId)
          throw assistantProblem("conflict", 409);
        result = this.store.rotate(id, patch.token, revision);
      } else result = this.store.update(id, patch, revision);
      this.assistants.changed();
      return result;
    });
  }
  pair(id, revision, appUrl, language) {
    return this.serialize(async () => {
      await this.stopChannel(id);
      if (
        this.ledger.active(id).length ||
        this.outbox.pending(id).length ||
        this.hasTeamWork(id)
      )
        throw assistantProblem("active", 409);
      const result = this.store.pairing(id, revision, appUrl, language);
      this.assistants.changed();
      return result;
    });
  }
  disconnect(id, revision) {
    return this.serialize(async () => {
      await this.stopChannel(id);
      if (this.outbox.pending(id).length || this.hasTeamWork(id))
        throw assistantProblem("active", 409);
      const result = this.store.disconnect(id, revision);
      this.assistants.changed();
      return result;
    });
  }
  recoverInput(channelId, inputId, action) {
    return this.serialize(async () => {
      await this.stopChannel(channelId);
      const entry = this.ledger.get(inputId);
      if (entry.channelId !== channelId) throw assistantProblem("notFound", 404);
      if (action === "retry" && entry.state === "transcription_failed")
        this.ledger.patch(inputId, { state: "voice_pending", diagnostic: null });
      else if (action === "retry" && entry.state === "delivery_failed" && entry.parts)
        this.ledger.patch(inputId, {
          state: "outbound",
          diagnostic: null,
          nextDeliveryAt: 0,
        });
      else if (
        action === "review" &&
        [
          "delivery_uncertain",
          "delivery_failed",
          "transcription_failed",
          "reply_unavailable",
          "model_reviewed",
          "model_uncertain",
        ].includes(entry.state)
      ) {
        if (
          entry.state === "model_uncertain" &&
          !this.assistants.ledger.getAttempt(entry.attemptId).reviewedAt
        )
          throw assistantProblem("active", 409);
        this.ledger.patch(inputId, { state: "reviewed" });
      } else throw assistantProblem("invalid");
      this.assistants.changed();
      return this.ledger.public(channelId);
    });
  }
  hasTeamWork(id) {
    return (
      this.assistants.teams?.store
        .list()
        .some(
          (t) =>
            t.origin?.channelId === id &&
            (!["completed", "failed", "cancelled", "declined"].includes(t.phase) ||
              (t.resultBatch && !this.teamOutbox.transferred(`result:${t.id}`))),
        ) || false
    );
  }
  recoverNotification(channelId, id, action) {
    return this.serialize(async () => {
      await this.stopChannel(channelId);
      const entry = this.outbox.get(id);
      if (entry.channelId !== channelId) throw assistantProblem("notFound", 404);
      if (
        action === "review" &&
        ["delivery_uncertain", "delivery_failed"].includes(entry.state)
      )
        this.outbox.transition(id, entry.state, { state: "reviewed" });
      else if (
        action === "retry" &&
        entry.state === "delivery_failed" &&
        entry.diagnostic !== "CHANNEL_DESTINATION_CHANGED"
      )
        this.outbox.transition(id, entry.state, {
          state: "outbound",
          diagnostic: null,
          nextDeliveryAt: 0,
        });
      else throw assistantProblem("invalid");
      this.assistants.changed();
      return this.outbox.public(channelId);
    });
  }
  async stopChannel(id) {
    this.pollers.get(id)?.controller.abort();
    this.workers.get(id)?.controller.abort();
    this.feedbackWorkers.get(id)?.controller.abort();
    await Promise.allSettled(
      [
        this.pollers.get(id)?.task,
        this.workers.get(id)?.task,
        this.feedbackWorkers.get(id)?.task,
      ].filter(Boolean),
    );
    this.validated.delete(id);
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }
  tick() {
    if (this.closed || this.mutating || this.paused || this.assistants.maintenance)
      return;
    const records = this.store.list();
    const offset = (this.cursor || 0) % Math.max(records.length, 1);
    this.cursor = offset + 1;
    for (const channel of [...records.slice(offset), ...records.slice(0, offset)]) {
      const token = this.store.secret(channel.id);
      if (!token || (!channel.enabled && !(channel.pairingExpiresAt > Date.now())))
        continue;
      if (
        !this.pollers.has(channel.id) &&
        this.pollers.size < 8 &&
        !(channel.pollAfter > Date.now())
      ) {
        const controller = new AbortController();
        const task = (async () => {
          if (this.validated.get(channel.id) !== token) {
            try {
              await this.clientFactory(token).identity(controller.signal);
            } catch (error) {
              if (!controller.signal.aborted)
                this.store.halt(
                  channel.id,
                  error.code === "TELEGRAM_WEBHOOK" ? error.code : "TELEGRAM_UNAVAILABLE",
                );
              return;
            }
            if (controller.signal.aborted || this.closed) return;
            this.validated.set(channel.id, token);
          }
          await this.ingress.poll(channel.id, controller.signal);
        })()
          .catch(() => {})
          .finally(() => this.pollers.delete(channel.id));
        this.pollers.set(channel.id, { controller, task });
      }
      if (!this.feedbackWorkers.has(channel.id) && this.feedbackWorkers.size < 8) {
        const controller = new AbortController();
        const task = this.feedback
          .process(channel.id, controller.signal)
          .catch(() => {})
          .finally(() => this.feedbackWorkers.delete(channel.id));
        this.feedbackWorkers.set(channel.id, { controller, task });
      }
      if (!this.workers.has(channel.id) && this.workers.size < 4) {
        const controller = new AbortController();
        const task = this.process(channel.id, controller.signal)
          .catch(() => {})
          .finally(() => this.workers.delete(channel.id));
        this.workers.set(channel.id, { controller, task });
      }
    }
  }
  async process(id, signal) {
    // Team notifications are shared by every channel; a broken team record must
    // not keep this channel's own inbox and outbox from moving.
    if (!signal.aborted) await this.teamOutbox.transfer();
    if (!signal.aborted) this.delivery.announceReview(id);
    if (!signal.aborted) await this.teamOutbox.process(id, signal);
    if (!signal.aborted) await this.speechService.process(this, id, signal);
    if (!signal.aborted) await this.ingress.dispatch(id);
    if (!signal.aborted) await this.delivery.process(id, signal);
  }
  async pause() {
    this.paused = true;
    const workers = [
      ...this.pollers.values(),
      ...this.workers.values(),
      ...this.feedbackWorkers.values(),
    ];
    for (const worker of workers) worker.controller.abort();
    await Promise.allSettled(workers.map((w) => w.task));
    await this.queue.catch(() => {});
  }
  resume() {
    this.paused = false;
    this.start();
    this.tick();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const worker of [
      ...this.pollers.values(),
      ...this.workers.values(),
      ...this.feedbackWorkers.values(),
    ])
      worker.controller.abort();
    await Promise.allSettled(
      [
        ...this.pollers.values(),
        ...this.workers.values(),
        ...this.feedbackWorkers.values(),
      ].map((w) => w.task),
    );
    await this.queue.catch(() => {});
    this.store.close();
    this.speech.close();
  }
}
