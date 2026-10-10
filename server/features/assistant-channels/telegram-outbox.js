import { telegramMessages } from "./telegram-messages.js";
import { sendTelegramParts } from "./telegram-send-parts.js";
const teamPath = (team) =>
  `/agents/${encodeURIComponent(team.parentAssistantId)}/teams/${encodeURIComponent(team.id)}`;
export class TelegramOutbox {
  constructor(service) {
    this.service = service;
    // Team id (or "*" for the whole team list) -> origin channel of a failing
    // transfer; surfaced as a channel diagnostic until the transfer succeeds.
    this.failures = new Map();
  }
  failed(key, channelId) {
    if (this.failures.has(key)) return;
    this.failures.set(key, channelId);
    this.service.assistants.changed();
  }
  recovered(key) {
    if (this.failures.delete(key)) this.service.assistants.changed();
  }
  diagnostic(channelId) {
    return [...this.failures.values()].some((id) => id === null || id === channelId)
      ? "TEAM_NOTIFICATION_FAILED"
      : null;
  }
  async transfer() {
    const teams = this.service.assistants.teams?.store;
    if (!teams) return;
    let list;
    try {
      list = teams.list();
      this.recovered("*");
    } catch {
      return this.failed("*", null);
    }
    for (const t of list) {
      if (t.origin?.kind !== "telegram") continue;
      // One unreadable team must not hold back every other team's notices.
      try {
        await this.transferTeam(t);
        this.recovered(t.id);
      } catch {
        this.failed(t.id, t.origin.channelId);
      }
    }
    for (const key of this.failures.keys())
      if (key !== "*" && !list.some((t) => t.id === key)) this.recovered(key);
  }
  async transferTeam(t) {
    const { assistants: a, outbox } = this.service;
    const source = {
      channelId: t.origin.channelId,
      chatId: t.origin.chatId,
      userId: t.origin.userId,
    };
    const path = teamPath(t);
    const msg = telegramMessages(this.service.store.get(t.origin.channelId));
    if (t.phase === "awaiting_approval" && !this.transferred(`approval:${t.id}`)) {
      const entry = outbox.enqueue({
        key: `team-approval:${t.id}`,
        source,
        teamId: t.id,
        kind: "team-approval",
        path,
        localized: true,
        text: [
          msg.teamApproval(t.objective, t.members.length),
          ...t.members.map((m, n) => `${n + 1}. ${m.name} · ${m.role}\n${m.assignment}`),
        ].join("\n\n"),
        actions: [
          {
            decision: "approve",
            label: msg.teamApprove,
            proposalId: t.id,
            revision: t.revision,
          },
          {
            decision: "decline",
            label: msg.teamDecline,
            proposalId: t.id,
            revision: t.revision,
          },
        ],
      });
      // Notification bookkeeping does not change the proposal revision a button
      // approves; use a separate durable transfer record instead.
      this.recordTransfer(`approval:${t.id}`, entry.id);
    }
    if (!this.transferred(`result:${t.id}`)) this.progress(t, source);
    if (!t.resultAttemptId || this.transferred(`result:${t.id}`)) return;
    const attempt = a.ledger.getAttempt(t.resultAttemptId);
    if (
      !["completed", "failed", "cancelled"].includes(attempt.state) &&
      !attempt.reviewedAt
    )
      return;
    let text;
    if (attempt.state === "completed") {
      const history = await a.history(t.parentConversationId);
      text = (history.stale ? [] : history.messages)
        .filter(
          (m) =>
            m.role === "assistant" &&
            [attempt.id, attempt.runtimeRunId].includes(m.runId),
        )
        .at(-1)?.text;
    }
    if (!text?.trim())
      text = [
        attempt.state === "completed"
          ? msg.teamResultNoText(t.objective)
          : msg.teamResultFailed(t.objective),
        ...(t.resultBatch || []).map(
          (m) =>
            `${m.name} · ${m.role} · ${msg.teamResultStates[m.phase]}\n${m.text || msg.teamReportUnavailable}`,
        ),
      ].join("\n\n");
    const entry = outbox.enqueue({
      key: `team-result:${t.id}`,
      source,
      teamId: t.id,
      kind: "team-result",
      path,
      localized: true,
      text: text.slice(0, 65536),
    });
    this.recordTransfer(`result:${t.id}`, entry.id);
  }
  progress(team, source) {
    const { outbox, assistants } = this.service;
    const msg = telegramMessages(this.service.store.get(source.channelId));
    const notify = (kind, text) => {
      const key = `${kind}:${team.id}`;
      if (this.transferred(key)) return;
      // Reuse an already-enqueued notification after a crash between the two
      // stores, even if the team's progress has changed since that enqueue.
      const entry =
        outbox.all(source.channelId).find((e) => e.key === `team-${key}`) ||
        outbox.enqueue({
          key: `team-${key}`,
          source,
          teamId: team.id,
          kind: `team-${kind}`,
          text,
          path: teamPath(team),
          localized: true,
        });
      this.recordTransfer(key, entry.id);
    };
    if (
      this.transferred(`approval:${team.id}`) &&
      (team.authorization?.kind === "approval" || team.phase === "declined")
    ) {
      notify(
        "decision",
        `${team.objective}\n\n${
          team.phase === "declined" ? msg.teamDeclined : msg.teamApproved
        }`,
      );
    }
    const members = assistants.teams.store.members(team.id);
    const running = members.filter((m) => m.phase === "running").length;
    const quote =
      team.authorization?.source === "ownerRequest" &&
      team.authorization.ownerRequestQuote;
    if (running && !team.resultBatch)
      notify(
        "started",
        [
          msg.teamStarted(team.objective, running, members.length),
          ...(quote ? [msg.teamStartedBecause(quote)] : []),
        ].join("\n\n"),
      );
  }
  transferred(key) {
    return !!this.service.assistants.teams.store.find(`notification:${key}`);
  }
  recordTransfer(key, outboxId) {
    const store = this.service.assistants.teams.store;
    if (!this.transferred(key))
      store.insert({
        id: `notification:${key}`,
        kind: "notification",
        revision: 1,
        outboxId,
      });
  }
  async process(id, signal) {
    const c = this.service,
      channel = c.store.get(id),
      token = c.store.secret(id);
    if (signal.aborted || !channel.enabled || !token) return;
    // Notices waiting for review stay put (never resent) without holding back
    // later notices; the oldest sendable one goes first.
    let entry = c.outbox.pending(id).find((e) => e.state === "outbound");
    if (!entry) return;
    if (entry.kind === "reminder" && !c.assistants.reminders?.acceptsDelivery(entry)) {
      c.outbox.transition(entry.id, entry.state, { state: "reviewed" });
      return;
    }
    if (entry.chatId !== channel.chatId || entry.userId !== channel.userId) {
      c.outbox.transition(entry.id, entry.state, {
        state: "delivery_failed",
        diagnostic: "CHANNEL_DESTINATION_CHANGED",
      });
      c.assistants.changed();
      return;
    }
    if (entry.kind === "action-approval") {
      const action = c.assistants.workflows?.get(entry.source.actionId);
      if (
        !action ||
        action.state !== "awaiting_approval" ||
        action.revision !== entry.actions[0]?.revision ||
        action.expiresAt < Date.now()
      ) {
        c.outbox.transition(entry.id, entry.state, { state: "reviewed" });
        return;
      }
    }
    if (entry.kind === "team-approval") {
      const team = c.assistants.teams.store.find(entry.teamId);
      if (
        !team ||
        team.phase !== "awaiting_approval" ||
        team.revision !== entry.actions[0].revision ||
        entry.actions[0].expiresAt < Date.now()
      ) {
        c.outbox.transition(entry.id, entry.state, { state: "reviewed" });
        return;
      }
    }
    await sendTelegramParts({
      client: c.clientFactory(token),
      entry,
      signal,
      save: (patch) => {
        const current = c.outbox.get(entry.id);
        return c.outbox.transition(entry.id, current.state, patch);
      },
      changed: () => c.assistants.changed(),
    });
  }
}
