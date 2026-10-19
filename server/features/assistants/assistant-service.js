import { assistantProblem, validateDefinition } from "./assistant-validation.js";
import { sendTurn } from "./conversation-turns.js";
import { AgentAttachments } from "./agent-attachments.js";
import { AgentShares } from "./agent-shares.js";
import { GeneratedImages } from "./generated-images.js";
import { createGatewaySession } from "./session-create.js";
import { RequestLedger } from "./request-ledger.js";
import { QueuedMessages } from "./queued-messages.js";
import * as queuedDispatch from "./queued-dispatch.js";
import { AssistantEvents } from "./assistant-events.js";
import { conversationHistory, conversationMessage } from "./conversations.js";
import { reconcileRuns } from "./run-reconciler.js";
import { recoverAttempt } from "./attempt-recovery.js";
import { GatewayEventHub } from "./gateway-event-hub.js";
import { MemoryFlushes } from "./memory-flushes.js";
import { MemoryNotes } from "./memory-notes.js";
import { watchCompactions } from "./compactions.js";
import { awaitWriteGuard, noteReadOnlyTurn, orderedTurn } from "./write-guard-wait.js";
import { webCapabilityKeys } from "./native-capabilities.js";
import { assertWired } from "./service-wiring.js";
import { ShellChanges, shellChange, withoutUnchanged } from "./shell-changes.js";
import { ExecAllowlist } from "./exec-allowlist.js";
import { AgentSkills } from "./agent-skills.js";
import { followLead } from "./member-follow.js";
import { assistantActivity } from "./assistant-activity.js";
import { temporaryMember } from "./team-presentation.js";
import { ChatStreams } from "./chat-stream.js";
import { conversationFeeds, reconciledChanges } from "./conversation-feeds.js";
import { bindChatEvents, runtimeStatusHandler } from "./gateway-wiring.js";
import { mainConversation } from "./routine-targets.js";
import { templateProblem, templateRecord } from "../agency/agency-templates.js";
import {
  auditProactivity,
  lacksMemory,
  proactivityChange,
} from "./proactivity-changes.js";

const sessionRetryMs = 60000;
const pick = (value, keys) => Object.fromEntries(keys.map((k) => [k, value[k]]));
export class AssistantService {
  constructor({
    store,
    models,
    runtime,
    config,
    login,
    accounts,
    audit,
    now = Date.now,
    // createGatewaySession options (a clock for tests); team members use them too.
    sessionCreate,
  }) {
    Object.assign(this, { store, models, runtime, config, login, accounts, audit, now });
    this.sessionCreate = sessionCreate;
    this.shellChanges = new ShellChanges(this, { now });
    config.onApplied = (id) => this.shellChanges.applied(id);
    config.onReapplied = (id) => followLead(this, id);
    this.allowlist = new ExecAllowlist(this);
    this.skills = new AgentSkills({ store, runtime });
    this.sessionFailures = new Map();
    this.ledger = new RequestLedger(store.db);
    this.queued = new QueuedMessages(store.db, now);
    this.attachments = new AgentAttachments({ store, models, config });
    // Copies a restart left half-written are removed before any quota counts them.
    void this.attachments.videos.sweepAll().catch(() => {});
    // Files agents hand the owner; the graph adds the Telegram channels.
    this.shares = new AgentShares({ assistants: this });
    this.generatedImages = new GeneratedImages(this);
    this.markOutstandingUnknown();
    // The previous process's Gateway can no longer confirm a lost send.
    this.ledger.forgetUnconfirmed();
    this.events = new AssistantEvents();
    this.chatStreams = new ChatStreams();
    // The open chats' live feeds (conversation-feeds.js).
    this.feeds = conversationFeeds(this);
    this.gatewayEvents = new GatewayEventHub();
    // A skill folder changed (one may now shadow an assigned skill), or a Gateway
    // started from a compile that could not ask it: re-apply agents with skills.
    const reapplySkills = () =>
      this.skills.changed(() => this.admit(() => this.skills.reapply(this.config)));
    this.gatewayEvents.on("skills.changed", reapplySkills);
    // The write guard admits OpenClaw's memory flush of an owner run (team-bridge.js).
    this.memoryFlushes = new MemoryFlushes({ now });
    this.memoryNotes = new MemoryNotes(store.db, now);
    this.gatewayEvents.on("agent", (payload) => this.memoryFlushes.observe(payload));
    // The chat says when a run summarises its conversation (compactions.js).
    this.compactions = watchCompactions(this, { now });
    this.gatewayEvents.onReady(reapplySkills);
    this.locks = new Map();
    this.closed = false;
    this.onStatus = runtimeStatusHandler(this);
    runtime.on("status", this.onStatus);
    this.bindGateway();
    this.poll = setInterval(() => this.pollReconcile(), 2000);
    this.poll.unref();
  }
  pollReconcile() {
    this.shellChanges.retry().catch(() => {});
    // Shared files past their 90 days go (at most hourly, agent-share-store.js).
    if (!this.maintenance && !this.recovering)
      this.attachments.shared.sweep().catch(() => {});
    queuedDispatch.pollQueued(this);
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
    this.memoryFlushes.clear();
    this.compactions?.clear();
    this.bindEvents();
    this.gatewayEvents.bind(this.runtime.client);
  }
  bindEvents() {
    bindChatEvents(this);
  }
  list() {
    assertWired(this);
    // The agents page shows the ChatGPT model lists; stale ones load in the background.
    this.accounts?.ensureModels?.();
    const teamData = this.teams?.list();
    const assistants = this.store.listAssistants().map((a) => this.withMcp(a));
    const conversations = this.store
      .listConversations()
      .map((c) =>
        this.sessionFailures.has(c.id)
          ? { ...c, diagnostic: this.sessionFailures.get(c.id).diagnostic }
          : c,
      );
    return {
      ...(teamData && {
        ...pick(teamData, ["teams", "members", "requests", "policies"]),
        teamSettings: teamData.settings,
      }),
      assistants,
      conversations,
      models: this.models.listCapabilities(),
      activity: assistantActivity({
        assistants,
        conversations,
        latest: this.ledger.latestByConversation(),
        awaiting: this.workflows?.store?.awaitingCounts(Date.now()) ?? {},
        teams: teamData?.teams ?? [],
        members: teamData?.members ?? [],
      }),
    };
  }
  /**
   * A new agent with shell needs the same confirmations as raising it later.
   * `template` ({id, revision}) records the Agency agent the owner started from:
   * fetched again at that revision and scanned, never its model or tools. The fetch
   * runs before admission: a slow GitHub never holds the shared admission lock.
   */
  async create(body) {
    const { confirmShell, confirmFull, template, ...input } = body || {};
    const origin = template === undefined ? null : await this.templateOrigin(template);
    return this.admit(async () => {
      const shell = shellChange({ shell: "off" }, input, { confirmShell, confirmFull });
      // Skills are assigned once the agent exists (agent-skills.js).
      if (input.skills?.length) throw assistantProblem("invalid");
      const lease = await this.models.resolve(input.model || {});
      lease.release();
      // Web capabilities need the Gateway sections an update can apply with the
      // owner's confirmation; a new agent starts with them off.
      const capabilities = input.capabilities && { ...input.capabilities };
      for (const key of webCapabilityKeys)
        if (capabilities && key in capabilities) capabilities[key] = false;
      // Check-ins are switched on in the saved agent (its settings), not at creation.
      const heartbeat = input.heartbeat && { ...input.heartbeat, enabled: false };
      const record = this.store.createAssistant(
        {
          ...input,
          ...(capabilities && { capabilities }),
          ...(heartbeat && { heartbeat }),
        },
        origin && { template: origin },
      );
      // The Gateway gets the agent, and its level, at its first apply.
      if (shell) this.shellChanges.audit(record.id, shell, {});
      auditProactivity(this.audit, record.id, proactivityChange({}, record));
      this.changed();
      return record;
    });
  }
  async templateOrigin(template) {
    if (
      !template ||
      typeof template !== "object" ||
      Array.isArray(template) ||
      Object.keys(template).some((k) => !["id", "revision"].includes(k)) ||
      typeof template.revision !== "string"
    )
      throw assistantProblem("invalid");
    if (!this.templates) throw templateProblem("templateUnavailable", 503);
    const t = await this.templates.template(template);
    if (t.scan.verdict === "block") throw templateProblem("templateBlocked", 422);
    return templateRecord(t);
  }
  /** The profile with its bound MCP server ids, for agents the owner binds. */
  withMcp(profile) {
    const decorated = this.shellChanges.decorate(profile);
    // The badge while the agent's own browser runs (agent-browsers.js).
    if (this.browsers?.isRunning(profile.id)) decorated.browserRunning = true;
    return this.mcp ? this.mcp.decorate(decorated) : decorated;
  }
  /** The decorated profile, flagged `pending` while the Gateway lags behind. */
  withPending(profile, pending) {
    const decorated = this.withMcp(profile);
    return pending ? { ...decorated, pending: true } : decorated;
  }
  /**
   * `confirmed` is the owner's consent to restart the Gateway when the change needs
   * global web tool sections the running Gateway was not started with. `mcpServers`
   * (server ids) replaces the agent's MCP bindings; adding a stdio server needs
   * `confirmStdio: true`. `outcome.stdioAdded` reports whether the change bound a new
   * stdio server. Raising the `shell` level needs `confirmShell: true`, to "full" also
   * `confirmFull: true`; lowering needs neither and applies even while the agent works
   * (shell-changes.js).
   */
  async update(id, input, revision, { confirmed = false, outcome = {} } = {}) {
    const { mcpServers, confirmStdio, confirmShell, confirmFull, ...body } = input || {};
    const binds = mcpServers !== undefined;
    let shell = null,
      patch = body;
    const restart = await this.admit(async () => {
      const changes = validateDefinition(body, true);
      if (binds && !this.mcp) throw assistantProblem("invalid");
      const current = this.store.getAssistant(id);
      if (current.revision !== revision) throw assistantProblem("conflict", 409);
      // A form sends every field; only the ones that differ are a change, so an
      // unchanged name or model never holds back lowering the shell level.
      patch = withoutUnchanged(body, changes, current);
      // A temporary member runs on its lead's model; only a permanent one has its own.
      if (patch.model && temporaryMember(current))
        throw assistantProblem("memberModelFollowsLead", 409);
      // Refuses an ineligible agent or a missing confirmation before any change.
      shell = shellChange(current, patch, { confirmShell, confirmFull });
      // People on the agent's own Telegram bot must never reach host commands.
      if (shell?.raised && this.telegramSenders?.connected(id))
        throw assistantProblem("telegramSendersShell", 409);
      // Only lowering the shell level: it must stop new commands at once, so a
      // running turn does not hold it back.
      const lowersOnly =
        shell &&
        !shell.raised &&
        !binds &&
        Object.keys(patch).every((k) => k === "shell");
      const member = this.teams?.store.find(id);
      if (
        !lowersOnly &&
        member?.kind === "member" &&
        this.teams.store.activeMember(member)
      )
        throw assistantProblem("active", 409);
      if (
        !lowersOnly &&
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
      // Check-ins need memory; refused before any change. They run in the main
      // chat, which the job opens when the agent has none yet.
      if (lacksMemory(current, patch))
        throw assistantProblem("heartbeatMemoryRequired", 409);
      // Refuses ineligible agents and unconfirmed stdio servers before any change.
      if (binds)
        outcome.stdioAdded = this.mcp.checkBindings(current, mcpServers, confirmStdio);
      // Only bundled skills the running Gateway reports, refused before any change.
      if (patch.skills) await this.skills.check(current, changes.skills);
      // Without the owner's confirmation nothing changes, not even reminders.
      // The browser profiles, and whether each opens a window, are global sections too.
      const restart =
        (!!patch.capabilities || "browserVisible" in patch) &&
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
      auditProactivity(this.audit, id, proactivityChange(current, patch));
      let pending = false;
      if (binds) {
        this.mcp.setBindings(id, mcpServers);
        // Patches the Gateway's MCP sections and re-applies agents whose globs changed.
        // The save is stored: a failed live apply stays pending instead of an error.
        pending = await this.mcp.applySaved();
      }
      // Saved first, so a request arriving now is denied (exec-approvals.js). A
      // failed live apply stays pending and is retried; never reported as live.
      if (shell) pending = (await this.shellChanges.settle(id, shell)) || pending;
      else if ((patch.capabilities || patch.skills) && this.runtime.client?.ready)
        await this.config.apply(id);
      pending = (await this.syncHeartbeat(id, patch)) || pending;
      this.changed();
      return { record, pending };
    });
    if (!restart.restart) return this.withPending(restart.record, restart.pending);
    // Maintenance drains the admission lock, so the restart runs outside admit() and
    // the decision above may be stale by now. A save that slipped in between fails
    // the revision check in updateAssistant after the restart, which is harmless:
    // the Gateway then simply runs with the current state.
    // The restarted Gateway compiles the new bindings at its start.
    const before = this.store.getAssistant(id);
    const record = await this.webTools.restart(
      () => {
        const saved = this.store.updateAssistant(id, patch, revision);
        auditProactivity(this.audit, id, proactivityChange(before, patch));
        if (binds) this.mcp.setBindings(id, mcpServers);
        return saved;
      },
      {
        beforeChange: restart.disableReminders
          ? () => this.reminders?.disable(id)
          : undefined,
      },
    );
    // The restarted Gateway's ready reconciles check-ins; this save repeats it.
    await this.admit(() => this.syncHeartbeat(id, patch)).catch(() => {});
    if (!shell) {
      if (this.runtime.client?.ready) await this.config.apply(id);
      return this.withMcp(record);
    }
    // The restarted Gateway compiled the level; the apply confirms it.
    return this.withPending(record, await this.shellChanges.settle(id, shell));
  }
  /**
   * Converges the agent's check-in job after a saved heartbeat or capability change
   * (memory decides its tools; switching reminders off pauses all its jobs). True
   * when it could not run now; the next Gateway ready repeats it.
   */
  async syncHeartbeat(id, patch) {
    const heartbeats = this.reminders?.heartbeats;
    if (!heartbeats || !(patch.heartbeat || patch.capabilities)) return false;
    try {
      await heartbeats.sync(id);
      return false;
    } catch {
      return true;
    }
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
  /**
   * Announces a change to the list (`change` event). A change of one conversation
   * names it, so only that chat's live feed reads its history again; without one,
   * every live feed does.
   */
  // `feeds: false`: only agent actions changed, whose writes already re-read the
  // feeds of their agents (AssistantWorkflows.written).
  changed({ conversationId, feeds = true } = {}) {
    if (feeds && conversationId) this.feeds?.invalidate(conversationId);
    else if (feeds) this.feeds?.invalidateAll();
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
    return this.admit(() => this.mainConversation(assistantId));
  }
  /**
   * The agent's main chat: its one AgentPier conversation, created on first use.
   * Telegram pairing, reminders, routines and check-ins all use it. Callers hold
   * admission (openConversation takes it). `turn: false` opens it for scheduled
   * work only, which need not wait for a member's team task to end.
   */
  async mainConversation(assistantId, { turn = true } = {}) {
    const existing = mainConversation(this.store, assistantId);
    if (existing) return existing;
    if (turn) this.teams?.assertMemberTurn(assistantId, { kind: "owner" });
    else if (this.store.getAssistant(assistantId).archivedAt)
      throw assistantProblem("active", 409);
    this.requireReady();
    await this.config.apply(assistantId);
    const assistant = this.store.getAssistant(assistantId);
    const created = await createGatewaySession(
      this.runtime.client,
      { agentId: assistant.runtimeAgentId, label: `AgentPier ${assistant.id}` },
      this.sessionCreate,
    );
    if (!created.key) throw assistantProblem("unavailable", 503);
    const conversation = this.store.saveConversation({
      assistantId,
      runtimeSessionKey: created.key,
    });
    await this.runtime.client.call("sessions.messages.subscribe", { key: created.key });
    this.changed();
    return conversation;
  }
  send(conversationId, input, trustedContext = { kind: "owner" }) {
    assertWired(this);
    return orderedTurn(
      this,
      conversationId,
      () => awaitWriteGuard(this, conversationId, input, trustedContext),
      () =>
        this.admit(() => sendTurn(this, conversationId, input, trustedContext)).then(
          ({ readOnly, ...result }) => {
            noteReadOnlyTurn(this, conversationId, trustedContext, {
              readOnly,
              ...result,
            });
            return result;
          },
        ),
    );
  }
  /** The owner's message for when the agent is done (queued-dispatch.js). */
  queue(conversationId, input) {
    assertWired(this);
    return queuedDispatch.queueMessage(this, conversationId, input);
  }
  takeBackQueued(conversationId) {
    return queuedDispatch.takeBackQueued(this, conversationId);
  }
  history(id, options) {
    return conversationHistory(this, id, options);
  }
  /** One message read on its own, beyond the history page's 8000 characters. */
  message(id, messageId) {
    return conversationMessage(this, id, messageId);
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
  /** Lets an uncertain or interrupted attempt be delivered again (attempt-recovery.js). */
  recover(id, input) {
    return recoverAttempt(this, id, input);
  }
  reconcile() {
    if (this.reconciling) return this.reconciling;
    if (!this.runtime.client?.ready || this.closed || this.maintenance)
      return Promise.resolve();
    this.reconciling = (async () => {
      let stale = false;
      const reads = new Map();
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
        reads.set(c.id, history);
        stale ||= history.stale;
      }
      await reconcileRuns(this);
      if (!this.closed) {
        this.runtime.setState({ sync: stale ? "stale" : "current" });
        // The poll reconciles every 2 s during a turn: only the chats whose history
        // or turns changed read their feed again; the list hears of every pass.
        for (const id of reconciledChanges(this, reads)) this.feeds.invalidate(id);
        this.events.publish({ type: "change" });
      }
    })().finally(() => {
      this.reconciling = null;
      // A turn that ended lets the conversation's queued message go out.
      queuedDispatch.dispatchQueued(this).catch(() => {});
    });
    return this.reconciling;
  }
  async close() {
    this.closed = true;
    clearInterval(this.poll);
    clearTimeout(this.skills.timer);
    this.liveView?.close();
    this.browsers?.close();
    this.unsubscribe?.();
    this.chatStreams.clear();
    this.feeds.close();
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
