import { assistantProblem, validateDefinition } from "./assistant-validation.js";
import { RequestLedger } from "./request-ledger.js";
import { AssistantEvents } from "./assistant-events.js";
import { conversationHistory } from "./conversations.js";
import { reconcileRuns } from "./run-reconciler.js";
import { GatewayEventHub } from "./gateway-event-hub.js";
import { webCapabilityKeys } from "./native-capabilities.js";
import { assertWired } from "./service-wiring.js";

const sessionRetryMs = 60000;
export class AssistantService {
  constructor({ store, models, runtime, config, login, accounts, now = Date.now }) {
    Object.assign(this, { store, models, runtime, config, login, accounts, now });
    this.sessionFailures = new Map();
    this.ledger = new RequestLedger(store.db);
    this.markOutstandingUnknown();
    this.events = new AssistantEvents();
    this.gatewayEvents = new GatewayEventHub();
    this.locks = new Map();
    this.closed = false;
    this.onStatus = (state) => {
      if (this.maintenance) {
        // A maintenance restart replaces the client while readiness is absorbed
        // here, so subscriptions follow it now; leaving maintenance resyncs.
        if (state.availability === "ready") this.bindGateway();
        this.lastAvailability = state.availability;
        this.events.publish({ type: "runtime", ...state });
        return;
      }
      if (state.availability === "failed") this.markOutstandingUnknown();
      this.events.publish({ type: "runtime", ...state });
      const becameReady =
        state.availability === "ready" && this.lastAvailability !== "ready";
      this.lastAvailability = state.availability;
      if (becameReady) {
        this.config.reset?.();
        this.bindGateway();
        this.gatewayEvents.ready();
        this.accounts
          ?.list()
          .then(() => this.changed())
          .catch(() => {});
        // A reconnect re-subscribes every session at once; a pass that started on
        // the previous connection must not absorb this one.
        this.sessionFailures.clear();
        (this.reconciling || Promise.resolve())
          .catch(() => {})
          .then(() => this.reconcile())
          .catch(() => {});
      }
    };
    runtime.on("status", this.onStatus);
    this.bindGateway();
    this.poll = setInterval(() => this.pollReconcile(), 2000);
    this.poll.unref();
  }
  pollReconcile() {
    const now = this.now();
    if (
      this.ledger.unresolved().length ||
      [...this.sessionFailures.values()].some((f) => f.retryAt <= now)
    )
      this.reconcile().catch(() => {});
  }
  markOutstandingUnknown() {
    for (const attempt of this.ledger.pending()) {
      if (["pending", "accepted", "running"].includes(attempt.state))
        this.ledger.transition(attempt.id, "uncertain");
    }
  }
  bindGateway() {
    this.bindEvents();
    this.gatewayEvents.bind(this.runtime.client);
  }
  bindEvents() {
    this.unsubscribe?.();
    this.unsubscribe = this.runtime.client?.subscribe((event) => {
      const payload = event.payload;
      if (!payload?.sessionKey) return;
      const conversation = this.store
        .listConversations()
        .find((c) => c.runtimeSessionKey === payload.sessionKey);
      if (!conversation) return;
      if (event.event === "chat" && payload.state === "delta")
        this.events.publish({
          type: "delta",
          conversationId: conversation.id,
          runId: payload.runId,
          text: String(
            payload.message?.content
              ?.filter?.((c) => c.type === "text")
              .map((c) => c.text)
              .join("") ||
              payload.deltaText ||
              "",
          ).slice(0, 65536),
        });
      if (event.event === "chat" && ["final", "aborted", "error"].includes(payload.state))
        this.reconcile().catch(() => {});
    });
  }
  list() {
    assertWired(this);
    const teamData = this.teams?.list();
    return {
      ...(teamData
        ? {
            teams: teamData.teams,
            members: teamData.members,
            policies: teamData.policies,
            teamSettings: teamData.settings,
          }
        : {}),
      assistants: this.store.listAssistants().map((a) => this.withMcp(a)),
      conversations: this.store
        .listConversations()
        .map((c) =>
          this.sessionFailures.has(c.id)
            ? { ...c, diagnostic: this.sessionFailures.get(c.id).diagnostic }
            : c,
        ),
      models: this.models.listCapabilities(),
    };
  }
  create(input) {
    return this.admit(async () => {
      const lease = await this.models.resolve(input.model || {});
      lease.release();
      // Web capabilities need the Gateway sections an update can apply with the
      // owner's confirmation; a new agent starts with them off.
      const capabilities = input.capabilities && { ...input.capabilities };
      for (const key of webCapabilityKeys)
        if (capabilities && key in capabilities) capabilities[key] = false;
      const record = this.store.createAssistant(
        capabilities ? { ...input, capabilities } : input,
      );
      this.changed();
      return record;
    });
  }
  /** The profile with its bound MCP server ids, for agents the owner binds. */
  withMcp(profile) {
    return this.mcp ? this.mcp.decorate(profile) : profile;
  }
  /**
   * `confirmed` is the owner's consent to restart the Gateway when the change needs
   * global web tool sections the running Gateway was not started with. `mcpServers`
   * (server ids) replaces the agent's MCP bindings; adding a stdio server needs
   * `confirmStdio: true`.
   */
  async update(id, input, revision, { confirmed = false } = {}) {
    const { mcpServers, confirmStdio, ...patch } = input || {};
    const binds = mcpServers !== undefined;
    const restart = await this.admit(async () => {
      validateDefinition(patch, true);
      if (binds && !this.mcp) throw assistantProblem("invalid");
      const current = this.store.getAssistant(id);
      if (current.revision !== revision) throw assistantProblem("conflict", 409);
      const member = this.teams?.store.find(id);
      if (member?.kind === "member" && this.teams.store.activeMember(member))
        throw assistantProblem("active", 409);
      if (
        this.ledger
          .pending()
          .some(
            (a) =>
              this.store.getConversation(
                this.ledger.getRequest(a.requestId).conversationId,
              ).assistantId === id,
          )
      )
        throw assistantProblem("active", 409);
      if (patch.model) {
        const lease = await this.models.resolve(patch.model);
        lease.release();
      }
      // Refuses ineligible agents and unconfirmed stdio servers before any change.
      if (binds) this.mcp.checkBindings(current, mcpServers, confirmStdio);
      // Without the owner's confirmation nothing changes, not even reminders.
      const restart =
        !!patch.capabilities &&
        !!this.webTools?.differs({ profiles: this.webTools.profilesWith(id, patch) });
      const disableReminders =
        !!current.capabilities?.reminders && patch.capabilities?.reminders === false;
      if (restart) {
        this.webTools.confirm(confirmed);
        // Reminders are switched off inside the restart, once no blocker can refuse.
        return { restart, disableReminders };
      }
      if (disableReminders) await this.reminders?.disable(id);
      const record = this.store.updateAssistant(id, patch, revision);
      if (binds) {
        this.mcp.setBindings(id, mcpServers);
        // Patches the Gateway's MCP sections and re-applies agents whose globs changed.
        await this.mcp.apply();
      }
      if (patch.capabilities && this.runtime.client?.ready) await this.config.apply(id);
      this.changed();
      return { record };
    });
    if (!restart.restart) return this.withMcp(restart.record);
    // Maintenance drains the admission lock, so the restart runs outside admit() and
    // the decision above may be stale by now. A save that slipped in between fails
    // the revision check in updateAssistant after the restart, which is harmless:
    // the Gateway then simply runs with the current state.
    // The restarted Gateway compiles the new bindings at its start.
    const record = await this.webTools.restart(
      () => {
        const saved = this.store.updateAssistant(id, patch, revision);
        if (binds) this.mcp.setBindings(id, mcpServers);
        return saved;
      },
      {
        beforeChange: restart.disableReminders
          ? () => this.reminders?.disable(id)
          : undefined,
      },
    );
    if (this.runtime.client?.ready) await this.config.apply(id);
    return this.withMcp(record);
  }
  admit(operation) {
    return this.serialize("admission", () => {
      if (this.closed || this.recovering || this.maintenance)
        throw assistantProblem("unavailable", 503);
      return operation();
    });
  }
  logoutAccount(accounts, id) {
    // Maintenance drains admission locks itself; entering it from admit() would
    // wait on this operation's own lock indefinitely.
    if (this.providerSynchronization) {
      this.requireReady();
      accounts.record(id);
      return this.providerSynchronization.change(id, () => accounts.logout(id), {
        online: true,
      });
    }
    return this.admit(async () => {
      if (
        this.ledger.pending().some((attempt) => {
          const request = this.ledger.getRequest(attempt.requestId);
          const conversation = this.store.getConversation(request.conversationId);
          return (
            this.store.getAssistant(conversation.assistantId).model.connectionId === id
          );
        })
      )
        throw assistantProblem("active", 409);
      const result = await accounts.logout(id);
      this.changed();
      return result;
    });
  }
  requireReady() {
    if (this.closed || this.recovering || !this.runtime.client?.ready)
      throw assistantProblem("unavailable", 503);
  }
  changed() {
    this.events.publish({ type: "change" });
  }
  serialize(key, operation) {
    const job = (this.locks.get(key) || Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.locks.set(key, job);
    job
      .finally(() => {
        if (this.locks.get(key) === job) this.locks.delete(key);
      })
      .catch(() => {});
    return job;
  }
  openConversation(assistantId) {
    assertWired(this);
    return this.admit(async () => {
      const existing = this.store
        .listConversations()
        .find(
          (c) =>
            c.assistantId === assistantId && c.channel === "agentpier" && !c.archivedAt,
        );
      if (existing) return existing;
      this.teams?.assertMemberTurn(assistantId, { kind: "owner" });
      this.requireReady();
      await this.config.apply(assistantId);
      const assistant = this.store.getAssistant(assistantId);
      const created = await this.runtime.client.call("sessions.create", {
        agentId: assistant.runtimeAgentId,
        label: `AgentPier ${assistant.id}`,
      });
      if (!created.key) throw assistantProblem("unavailable", 503);
      const conversation = this.store.saveConversation({
        assistantId,
        runtimeSessionKey: created.key,
      });
      await this.runtime.client.call("sessions.messages.subscribe", { key: created.key });
      this.changed();
      return conversation;
    });
  }
  send(conversationId, input, trustedContext = { kind: "owner" }) {
    assertWired(this);
    return this.admit(async () => {
      if (
        !input ||
        Object.keys(input).some(
          (k) => !["clientRequestId", "text", "teamAllowed"].includes(k),
        ) ||
        ("teamAllowed" in input && typeof input.teamAllowed !== "boolean")
      )
        throw assistantProblem("invalid");
      const context = {
        ...trustedContext,
        teamAllowed:
          ["owner", "telegram"].includes(trustedContext.kind) &&
          (input.teamAllowed === true ||
            (trustedContext.kind === "owner" && /^\/team\s+\S/.test(input.text))),
      };
      const conversation = this.store.getConversation(conversationId);
      const existing = this.ledger
        .requests(conversationId)
        .find((r) => r.clientRequestId === input.clientRequestId);
      if (existing) {
        const request = this.ledger.accept(conversationId, input);
        this.teams?.store.recordContext(request.id, context);
        return { request, attempt: this.ledger.attemptFor(request.id) };
      }
      this.requireReady();
      if (
        this.ledger
          .pending()
          .some(
            (a) => this.ledger.getRequest(a.requestId).conversationId === conversationId,
          )
      )
        throw assistantProblem("active", 409);
      this.teams?.assertMemberTurn(conversation.assistantId, context);
      await this.config.apply(conversation.assistantId);
      this.teams?.assertMemberTurn(conversation.assistantId, context);
      const accept = () => {
        const request = this.ledger.accept(conversationId, input);
        this.teams?.store.recordContext(request.id, context);
        return { request, attempt: this.ledger.recordAttempt(request.id) };
      };
      const { request, attempt } = this.teams
        ? this.teams.store.transaction(accept)
        : accept();
      try {
        const sent = await this.runtime.client.call("sessions.send", {
          key: conversation.runtimeSessionKey,
          message: request.text,
          idempotencyKey: attempt.id,
        });
        this.ledger.transition(attempt.id, "accepted", { runtimeRunId: sent.runId });
      } catch {
        this.ledger.transition(attempt.id, "uncertain", {});
      }
      this.changed();
      return {
        request: this.ledger.getRequest(request.id),
        attempt: this.ledger.getAttempt(attempt.id),
      };
    });
  }
  history(id, options) {
    return conversationHistory(this, id, options);
  }
  async cancel(id) {
    this.requireReady();
    const attempt = this.ledger.getAttempt(id);
    const conversation = this.store.getConversation(
      this.ledger.getRequest(attempt.requestId).conversationId,
    );
    await this.runtime.client.call("sessions.abort", {
      key: conversation.runtimeSessionKey,
      runId: attempt.runtimeRunId || attempt.id,
    });
    await this.reconcile();
    return this.ledger.getAttempt(id);
  }
  async recover(id, input) {
    if (input?.acknowledgeUnknownOutcome !== true) throw assistantProblem("invalid");
    const attempt = this.ledger.getAttempt(id);
    if (!["uncertain", "interrupted"].includes(attempt.state))
      throw assistantProblem("active", 409);
    if (
      this.ledger
        .pending()
        .some((a) => a.id !== id && !["uncertain", "interrupted"].includes(a.state))
    )
      throw assistantProblem("active", 409);
    if (this.recovering) throw assistantProblem("active", 409);
    this.recovering = true;
    try {
      // Confirm the owned process has exited before permitting another delivery.
      await this.runtime.stop();
      await Promise.allSettled(
        [...this.locks.values(), this.reconciling].filter(Boolean),
      );
      const current = this.ledger.getAttempt(id);
      if (["uncertain", "interrupted"].includes(current.state)) this.ledger.review(id);
      await this.runtime.start();
      this.changed();
      return this.ledger.getAttempt(id);
    } finally {
      this.recovering = false;
    }
  }
  reconcile() {
    if (this.reconciling) return this.reconciling;
    if (!this.runtime.client?.ready || this.closed || this.maintenance)
      return Promise.resolve();
    this.reconciling = (async () => {
      let stale = false;
      for (const c of this.store.listConversations()) {
        // One unavailable session must not stall run reconciliation for the rest.
        if (this.closed) break;
        if (this.now() < (this.sessionFailures.get(c.id)?.retryAt ?? -Infinity)) continue;
        const client = this.runtime.client;
        try {
          await client.call("sessions.messages.subscribe", { key: c.runtimeSessionKey });
          this.sessionFailures.delete(c.id);
        } catch {
          // A dropped connection is not a session fault; the reconnect resubscribes.
          if (this.runtime.client !== client || !client.ready) break;
          this.sessionFailures.set(c.id, {
            diagnostic: "SESSION_UNAVAILABLE",
            retryAt: this.now() + sessionRetryMs,
          });
          continue;
        }
        const history = await this.history(c.id);
        stale ||= history.stale;
      }
      await reconcileRuns(this);
      if (!this.closed) {
        this.runtime.setState({ sync: stale ? "stale" : "current" });
        this.changed();
      }
    })().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }
  async close() {
    this.closed = true;
    clearInterval(this.poll);
    this.unsubscribe?.();
    this.gatewayEvents.unsubscribe?.();
    this.runtime.off("status", this.onStatus);
    await this.workflows?.close();
    await this.teams?.close();
    await this.login?.close();
    await this.runtime.close();
    await this.reminders?.close();
    await Promise.allSettled([...this.locks.values(), this.reconciling].filter(Boolean));
    this.markOutstandingUnknown();
    this.events.close();
    this.store.close();
  }
}
