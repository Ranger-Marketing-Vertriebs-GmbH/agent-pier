import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { eventIdOf, HookEvents } from "./agent-hook-events.js";
import { HookRuns, runSession } from "./agent-hook-runs.js";
import { HookStore, newSecret } from "./agent-hook-store.js";
import { payloadCut } from "./agent-hook-prompt.js";
import { eventActions } from "./agent-event-area.js";
import {
  effectiveRights,
  hookDefaults,
  hookEligible,
  keptRightsInput,
  rightsInput,
  shellChoices,
} from "./agent-hook-rights.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";
import { goalAgent } from "./goal-turns.js";
import { personalCapabilities, personalShell } from "./native-capabilities.js";
import {
  mainConversation,
  pairedChannel,
  sameTelegram,
  telegramTarget,
} from "./routine-targets.js";
import { agentName } from "./reminder-audience.js";

const defaultHourlyLimit = 20;
const createKeys = ["name", "sender", "instruction", "rights", "hourlyLimit"];
const updateKeys = ["revision", ...createKeys, "enabled"];
const unavailable = (status = 403) => assistantProblem("hookUnavailable", status);
// The rights a hook holds above a new hook's defaults, by name (audited).
const raised = (rights) =>
  Object.keys(hookDefaults).filter(
    (key) => !isDeepStrictEqual(rights[key], hookDefaults[key]),
  );

// A one-line label (name, sender): no line breaks or control characters, so text
// the agent proposes cannot fake another line of the owner's approval card.
function label(value) {
  const text = textValue(value, 100);
  if (/[\p{Cc}\u2028\u2029]/u.test(text)) throw assistantProblem("invalid");
  return text;
}

function hourlyLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200)
    throw assistantProblem("invalid");
  return value;
}

/**
 * Agent hooks: owner-managed incoming webhooks that wake a goal agent. Each hook
 * holds a hashed secret, the rights a run of it may use (capped live by what the
 * agent holds, agent-hook-rights.js) and an hourly wake-up limit. Reached as
 * `routines.hooks`; its events live in HookEvents, its runs in `runs`.
 */
export class AgentHooks {
  constructor({ reminders, routines, notifications, addresses }) {
    Object.assign(this, { reminders, routines, notifications, addresses });
    this.assistants = reminders.assistants;
    this.store = new HookStore(this.assistants.store.db);
    this.events = new HookEvents(this.assistants.store.db);
    this.runs = new HookRuns(this);
    routines.hooks = this;
    // Completions arrive on the reminder webhook's second route.
    reminders.webhook.receiveHook = (id, event) => this.runs.complete(id, event);
    const hub = this.assistants.gatewayEvents;
    hub?.on("agent", (payload) => this.runs.observe(payload));
    hub?.onReady(() => this.runs.reconcile());
  }
  /** A goal agent: hooks are listed and removed even while reminders are off. */
  agent(assistantId) {
    const agent = this.assistants.store.getAssistant(assistantId);
    if (!goalAgent(agent)) throw unavailable();
    return agent;
  }
  /** An agent that may hold working hooks (goal agent with reminders on). */
  eligible(assistantId) {
    const agent = this.assistants.store.getAssistant(assistantId);
    if (!hookEligible(agent)) throw unavailable();
    return agent;
  }
  owned(assistantId, hookId) {
    const hook = this.store.get(hookId);
    if (!hook || hook.assistantId !== assistantId)
      throw assistantProblem("notFound", 404);
    return hook;
  }
  /** What a hook of the agent may hold now, read live on every call. */
  ceiling(agent) {
    const caps = personalCapabilities(agent);
    const workflows = this.assistants.workflows;
    const access = workflows.access.get(agent.id);
    // Hosts the SSH catalog no longer lists (or cannot read) are not offered.
    const listed = new Set((workflows.access.sshHosts() || []).map((host) => host.id));
    return {
      telegram: !!pairedChannel(this.routines.channels, agent.id),
      research: caps.webSearch || caps.webFetch,
      webSearch: caps.webSearch,
      webFetch: caps.webFetch,
      coding: access.projectIds.length > 0,
      shell: personalShell(agent),
      sshHosts: access.sshAccesses
        .filter(({ accessId, mode }) => mode === "routines" && listed.has(accessId))
        .map(({ accessId }) => accessId),
      folders: workflows.folders.ownAndShared(agent.id),
      memory: caps.memory,
      mcp: (this.assistants.config.mcpTools?.(agent) || []).length > 0,
      // Granted secrets that still exist (assistant-access.js secretIds).
      secrets: (access.secretIds || []).length > 0,
    };
  }
  /**
   * Whether the agent's secrets file is withheld now: while an event of one of its
   * hooks runs without Secrets (HookRuns.start marks it), every sync leaves the file
   * away (agent-secrets.js), for the agent's other chats too.
   */
  withholdsSecrets(assistantId) {
    return this.events
      .unsettled()
      .some((event) => event.assistantId === assistantId && event.secretsWithheld);
  }
  /**
   * Whether a session may read the agent's secrets folder with a file tool: every
   * session but a hook run's, and a hook run's only while its event runs with
   * Secrets decided at its start and still held now. A settled run, an event from
   * before the switch and a deleted or paused hook read nothing.
   */
  secretsRead(input) {
    if (!input || typeof input !== "object") throw assistantProblem("invalid");
    textValue(input.agentId, 4096);
    if (input.sessionKey !== undefined) textValue(input.sessionKey, 4096);
    const match = runSession.exec(input.sessionKey ?? "");
    const event = match && this.events.byJob(match[2]);
    if (!event) return { allow: true };
    let agent;
    try {
      agent = this.assistants.store.getAssistant(event.assistantId);
    } catch {
      return { allow: false };
    }
    if (agent.runtimeAgentId?.toLowerCase() !== String(input.agentId).toLowerCase())
      return { allow: false };
    const origin = this.runOrigin(agent, input.sessionKey, event);
    return { allow: event.secretsRead === true && origin?.effective.secrets === true };
  }
  /** Writes the agent's secrets file as it should be now; throws when that fails. */
  async syncSecrets(assistantId) {
    await this.assistants.config.syncSecrets?.(assistantId);
  }
  /** Gives the file back once no run withholds it; never throws. */
  releaseSecrets(assistantId) {
    if (this.withholdsSecrets(assistantId)) return;
    this.syncSecrets(assistantId).catch((error) =>
      console.error("Agent secrets file could not be restored:", error?.code || "error"),
    );
  }
  view(hook, agent, ceiling) {
    const last = this.events.last(hook.id);
    return {
      id: hook.id,
      name: hook.name,
      sender: hook.sender,
      instruction: hook.instruction,
      rights: hook.rights,
      effective: effectiveRights(hook.rights, ceiling),
      ceiling,
      shellChoices: shellChoices(ceiling.shell),
      hourlyLimit: hook.hourlyLimit,
      enabled: hook.enabled,
      active: hook.enabled && hookEligible(agent),
      secretSet: !!hook.secretHash,
      secretSetAt: hook.secretSetAt ?? null,
      revision: hook.revision,
      createdAt: hook.createdAt,
      createdBy: hook.createdBy,
      addresses: this.addresses(hook.id),
      lastEvent: last
        ? { status: last.status, receivedAt: new Date(last.receivedAt).toISOString() }
        : null,
    };
  }
  /** The hook as the owner sees it after a change: its agent's live ceiling. */
  shown(hook, agent) {
    return this.view(hook, agent, this.ceiling(agent));
  }
  list(assistantId) {
    const agent = this.agent(assistantId);
    const ceiling = this.ceiling(agent);
    return {
      hooks: this.store.list(assistantId).map((hook) => this.view(hook, agent, ceiling)),
      ceiling,
      shellChoices: shellChoices(ceiling.shell),
    };
  }
  /** Checked values of the submitted fields (all of them on create). */
  fields(input, keys, agent, create, stored) {
    exact(input, keys);
    const values = {};
    if (create || "name" in input) values.name = label(input.name);
    if (create || "sender" in input) values.sender = label(input.sender);
    if (create || "instruction" in input)
      values.instruction = textValue(input.instruction ?? "", 4096, true);
    if (create || "rights" in input)
      values.rights = stored
        ? keptRightsInput(input.rights, this.ceiling(agent), stored.rights)
        : rightsInput(input.rights ?? {}, this.ceiling(agent));
    if (create || "hourlyLimit" in input)
      values.hourlyLimit = hourlyLimit(input.hourlyLimit ?? defaultHourlyLimit);
    if ("enabled" in input) {
      if (typeof input.enabled !== "boolean") throw assistantProblem("invalid");
      values.enabled = input.enabled;
    }
    return values;
  }
  /** `actor` "assistant": created from the agent's accepted proposal, without a secret. */
  create(assistantId, input, { actor = "owner", proposalId } = {}) {
    const agent = this.eligible(assistantId);
    const values = this.fields(input, createKeys, agent, true);
    const fresh = actor === "owner" ? newSecret() : null;
    const hook = this.store.create({
      assistantId,
      ...values,
      enabled: true,
      secretHash: fresh?.hash ?? null,
      secretSetAt: fresh ? new Date().toISOString() : null,
      createdBy: actor,
      ...(proposalId && { proposalId }),
    });
    this.audit("assistant.updated", hook, {
      change: "create",
      rights: raised(hook.rights),
      ...(actor === "assistant" && { actor }),
    });
    const view = this.shown(hook, agent);
    return fresh ? { hook: view, secret: fresh.secret } : { hook: view };
  }
  update(assistantId, hookId, input) {
    const agent = this.eligible(assistantId);
    const before = this.owned(assistantId, hookId);
    if (!Number.isSafeInteger(input?.revision)) throw assistantProblem("invalid");
    const values = this.fields(input, updateKeys, agent, false, before);
    const hook = this.store.patch(hookId, values, input.revision);
    let change = "update";
    if (before.enabled !== hook.enabled) change = hook.enabled ? "enable" : "pause";
    this.audit("assistant.updated", hook, { change, rights: raised(hook.rights) });
    return this.shown(hook, agent);
  }
  /** Creates or regenerates the secret; the old one stops matching at once. */
  secret(assistantId, hookId, { revision } = {}) {
    const agent = this.eligible(assistantId);
    this.owned(assistantId, hookId);
    if (!Number.isSafeInteger(revision)) throw assistantProblem("invalid");
    const fresh = newSecret();
    const hook = this.store.patch(
      hookId,
      { secretHash: fresh.hash, secretSetAt: new Date().toISOString() },
      revision,
    );
    this.audit("assistant.updated", hook, { change: "secret" });
    return { hook: this.shown(hook, agent), secret: fresh.secret };
  }
  /**
   * Deletes the hook with its events; a running event's job is cancelled best-effort
   * and its row stays as a tombstone, so its session keeps no rights (forget).
   */
  remove(assistantId, hookId) {
    this.agent(assistantId);
    const hook = this.owned(assistantId, hookId);
    this.store.remove(hookId);
    // Cancelling reads the running events first; reconcile removes what is left.
    this.runs.cancel(hookId).catch(() => {});
    this.events.forget(hookId);
    this.releaseSecrets(assistantId);
    this.audit("assistant.updated", hook, { change: "delete" });
    return { removed: true };
  }
  /**
   * One incoming event of an enabled hook on an eligible agent (the endpoint checked
   * both): a repeat answers `duplicate` even while the runtime is down, a not-ready
   * runtime records nothing, an event over the hourly limit is kept `throttled`, and
   * a fresh one wakes the agent. A failed start forgets the event, so the sender's
   * retry runs. Every outcome is audited, never the payload or headers.
   */
  async deliver(hook, { text, json, contentType, size, headers, source }) {
    const eventId = eventIdOf({ headers, text, json });
    const answer = (status, outcome, event) => {
      this.audit(
        "assistant.updated",
        hook,
        {
          kind: "hook-delivery",
          eventKey: eventId,
          outcome,
          branch: source,
          size,
          ...(event && { hookEventId: event.id }),
        },
        status === 503 ? "failure" : "success",
      );
      return { status, body: { eventId, status: outcome } };
    };
    const input = { eventId, payload: text, size, contentType, source };
    if (this.events.find(hook.id, eventId))
      return answer(200, "duplicate", this.events.admit(hook, input).event);
    if (!this.assistants.runtime.client?.ready) return answer(503, "unavailable");
    const admitted = this.events.admit(hook, { ...input, test: source === "test" });
    const { event } = admitted;
    if (admitted.outcome === "duplicate") return answer(200, "duplicate", event);
    if (admitted.outcome === "throttled") {
      if (admitted.firstThrottled) this.throttled(hook);
      return answer(200, "throttled", event);
    }
    try {
      await this.runs.start(hook, event);
    } catch {
      // A start that failed once its job existed may still run: its session keeps a
      // hook event without rights (HookEvents.tombstone); the retry runs afresh.
      if (this.events.get(event.id)?.jobId) this.events.tombstone(event.id);
      else this.events.remove(event.id);
      this.releaseSecrets(hook.assistantId);
      return answer(503, "unavailable");
    }
    return answer(202, "accepted", event);
  }
  /**
   * A delivery the endpoint refused before `deliver` (unauthorized, not-found,
   * too-large, invalid): hook, outcome, branch and bytes read, nothing else.
   */
  refused(hook, { outcome, branch, size }) {
    this.audit(
      "assistant.updated",
      hook,
      { kind: "hook-delivery", outcome, branch, size },
      "failure",
    );
  }
  /**
   * The one push notice of an hour in which the hook went over its limit: its own
   * kind, since nothing was written to the chat.
   */
  throttled(hook) {
    const conversation = mainConversation(this.assistants.store, hook.assistantId);
    Promise.resolve()
      .then(() =>
        this.notifications?.notify({
          kind: "agent-hook-throttled",
          assistantId: hook.assistantId,
          ...(conversation && { conversationId: conversation.id }),
          eventId: `hook-throttled-${randomUUID()}`,
          label: agentName(this.assistants, hook.assistantId),
        }),
      )
      .catch(() => {});
  }
  /** The owner's test event: a fixed sample through the same pipeline. */
  async test(assistantId, hookId) {
    const agent = this.agent(assistantId);
    const hook = this.owned(assistantId, hookId);
    if (!hook.enabled || !hookEligible(agent)) throw unavailable(409);
    const json = {
      test: true,
      message: "Test event from AgentPier",
      sentAt: new Date().toISOString(),
    };
    const text = JSON.stringify(json);
    const { status, body } = await this.deliver(hook, {
      text,
      json,
      contentType: "application/json",
      size: Buffer.byteLength(text),
      headers: { "idempotency-key": `test-${randomUUID()}` },
      source: "test",
    });
    if (status === 503) throw assistantProblem("unavailable", 503);
    return body;
  }
  /**
   * One event of the hook for the event area: what came in (the payload as stored
   * text, cut to 16 KiB; the client shows it as plain text) and what the run did.
   */
  eventDetail(assistantId, hookId, eventRowId) {
    this.agent(assistantId);
    this.owned(assistantId, hookId);
    const event = this.events.get(eventRowId);
    if (!event || event.hookId !== hookId || event.assistantId !== assistantId)
      throw assistantProblem("notFound", 404);
    const stored = this.events.payload(event.id);
    const cut = stored === null ? null : payloadCut(stored);
    const { coding, remote } = eventActions(
      this.assistants.workflows,
      assistantId,
      event,
    );
    return {
      receivedAt: new Date(event.receivedAt).toISOString(),
      size: event.size,
      contentType: event.contentType,
      source: event.source,
      payload: cut?.text ?? null,
      payloadCut: !!cut?.omitted,
      activity: event.activity || [],
      coding,
      remote,
      notified: event.notified || null,
      reply: event.reply ?? null,
    };
  }
  /**
   * The hook event a native run session belongs to while it runs, with the rights it
   * holds now; null for any other session, a settled event or a paused or deleted
   * hook.
   */
  runOrigin(agent, sessionKey, found) {
    const match = runSession.exec(typeof sessionKey === "string" ? sessionKey : "");
    if (!match || match[1].toLowerCase() !== agent?.runtimeAgentId?.toLowerCase())
      return null;
    // `found`: the session's event a caller already looked up (hookLockedTool).
    const event = found ?? this.events.byJob(match[2]);
    if (event?.status !== "running" || event.assistantId !== agent.id) return null;
    const hook = this.store.get(event.hookId);
    if (!hook?.enabled || !hookEligible(agent)) return null;
    const conversation = mainConversation(this.assistants.store, agent.id);
    if (!conversation) return null;
    const ceiling = this.ceiling(agent);
    return {
      hook,
      event,
      conversation,
      effective: effectiveRights(hook.rights, ceiling),
      ceiling,
    };
  }
  /** Telegram outbox entries of hook results: only while the hook still sends there. */
  acceptsDelivery(entry) {
    const event = this.events.get(entry.source?.hookEventId);
    const hook = event && this.store.get(event.hookId);
    if (!hook?.enabled) return false;
    let agent;
    try {
      agent = this.assistants.store.getAssistant(hook.assistantId);
    } catch {
      return false;
    }
    if (!hookEligible(agent)) return false;
    const effective = effectiveRights(hook.rights, this.ceiling(agent));
    const channel = pairedChannel(this.routines.channels, agent.id);
    return (
      effective.notify &&
      effective.telegram &&
      !!channel &&
      sameTelegram({ telegram: telegramTarget(channel) }, entry)
    );
  }
  /** Owner changes ("hook") and deliveries ("hook-delivery"); never throws. */
  audit(action, hook, details, outcome = "success") {
    const kind = details.kind || "hook";
    try {
      this.assistants.audit?.append({
        action,
        resourceType: "assistant",
        resourceId: hook.assistantId,
        source: kind === "hook-delivery" ? "system" : "user",
        outcome,
        details: { kind, hookId: hook.id, ...details },
      });
    } catch (error) {
      console.error("Agent hook audit failed:", error?.message);
    }
  }
}
