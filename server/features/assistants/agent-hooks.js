import { isDeepStrictEqual } from "node:util";
import { HookEvents } from "./agent-hook-events.js";
import { HookStore, newSecret } from "./agent-hook-store.js";
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
import { pairedChannel } from "./routine-targets.js";

const defaultHourlyLimit = 20;
const createKeys = ["name", "sender", "instruction", "rights", "hourlyLimit"];
const updateKeys = ["revision", ...createKeys, "enabled"];
const unavailable = (status = 403) => assistantProblem("hookUnavailable", status);
// The rights a hook holds above a new hook's defaults, by name (audited).
const raised = (rights) =>
  Object.keys(hookDefaults).filter(
    (key) => !isDeepStrictEqual(rights[key], hookDefaults[key]),
  );

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
    // Set by the run service; until then nothing runs to cancel.
    this.runs = null;
    routines.hooks = this;
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
    };
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
    if (create || "name" in input) values.name = textValue(input.name, 100);
    if (create || "sender" in input) values.sender = textValue(input.sender, 100);
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
  /** Deletes the hook with its events; a running event's job is cancelled best-effort. */
  remove(assistantId, hookId) {
    this.agent(assistantId);
    const hook = this.owned(assistantId, hookId);
    this.store.remove(hookId);
    this.events.forget(hookId);
    try {
      Promise.resolve(this.runs?.cancel(hookId)).catch(() => {});
    } catch {
      /* Cancelling is best-effort: reconcile removes what is left. */
    }
    this.audit("assistant.updated", hook, { change: "delete" });
    return { removed: true };
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
