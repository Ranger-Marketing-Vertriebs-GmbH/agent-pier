import { createHmac, randomBytes } from "node:crypto";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { mcpEligible, readMcpInputs, withInherited } from "../mcp-servers/mcp-inputs.js";
import { placeholderViews } from "./mcp-placeholder-view.js";
import { desiredState } from "./agent-desired-state.js";
import { temporaryMember } from "./team-presentation.js";
import {
  STDIO_CONFIRMATION_REQUIRED,
  changesStdio as stdioChange,
  requireStdioConfirmation,
} from "../mcp-servers/stdio-confirmation.js";
import { requireLiteralValues } from "../mcp-servers/value-references.js";
import {
  agentWorkspace,
  hostReady,
  ownProcess,
  runtimeAccepts,
  runtimeFor,
} from "./runtimes/runtime-for.js";

export { STDIO_CONFIRMATION_REQUIRED };

const messages = serverMessages.mcpServers;
// Retry delays of a failed live apply: doubling from one second to one minute.
const firstRetryMs = 1000;
const lastRetryMs = 60000;
// Per process: the fingerprints of a Hermes agent's inputs hold secrets' digests.
const signatureKey = randomBytes(32);

/**
 * Agent bindings of central MCP servers and their live application. OpenClaw
 * hot-applies `mcp` and `tools.allow` even under the team plugin (see
 * docs/assistant-mcp-qualification.md), so no change needs a Gateway restart: a
 * ready Gateway that compiled MCP servers at its start is patched at once, any other
 * state compiles the store at the next start.
 */
export class McpChanges {
  constructor({
    assistants,
    servers,
    redirectUrl = () => null,
    oauth = null,
    now = Date.now,
    warn = console.warn,
    adoptionTimeoutMs,
  }) {
    // `redirectUrl()`: the OAuth redirect URL OAuth servers compile with, read at
    // each compile so a changed AgentPier origin hot-applies. `oauth`
    // (McpOAuthLogins) logs a server out before a change would orphan its login.
    Object.assign(this, { assistants, servers, redirectUrl, oauth, now, warn });
    this.adoption = { warn, timeoutMs: adoptionTimeoutMs };
    // Whether the running Gateway may lag behind the store. Set by every apply that
    // could not finish; the team scheduler's tick and each Gateway start retry it.
    this.pending = false;
    this.failures = 0;
    this.retryAt = 0;
    // Agents whose profile re-apply after a patch is still outstanding.
    this.stale = new Set();
    // Each Hermes agent's inputs as its last apply here compiled them (agentSignature).
    this.applied = new Map();
    // `{ [assistantId]: serverId[] }` members use through their lead, wired by the
    // graph (lead-shares.js mcpBindings).
    this.inherited = () => this.assistants.workflows?.shares?.mcpBindings() || {};
  }
  /** Whether a pending apply is due now (failures back off up to one minute). */
  due() {
    return this.pending && this.now() >= this.retryAt;
  }
  /** A Gateway start answered: a pending apply is retried at once. */
  ready() {
    this.retryAt = 0;
  }
  failed(error) {
    this.pending = true;
    this.failures++;
    this.retryAt =
      this.now() + Math.min(lastRetryMs, firstRetryMs * 2 ** (this.failures - 1));
    // One diagnostic per failure streak, with the error code only: no values.
    if (this.failures === 1)
      this.warn(
        `MCP servers could not be applied to the running Gateway (${
          error?.code || error?.name || "ERROR"
        }); retrying.`,
      );
  }
  settled() {
    Object.assign(this, { pending: false, failures: 0, retryAt: 0 });
  }
  /** Personal agents and permanent members; temporary members get team bindings. */
  ownerManaged(profile) {
    return mcpEligible(profile) && !temporaryMember(profile);
  }
  /** The profile as responses show it: with its bound server ids when owner-managed. */
  decorate(profile) {
    if (!profile || !this.ownerManaged(profile)) return profile;
    try {
      return {
        ...profile,
        mcpServers: this.servers.bindings("agent", profile.id),
        // Such an agent can bind remote servers only (checkBindings).
        ...(this.telegramSenders?.connected(profile.id) && { telegramSenders: true }),
      };
    } catch {
      // An unreadable server store must not fail the agent list; bindings are omitted.
      return profile;
    }
  }
  /**
   * Validates a new binding set for `profile` before anything is persisted. Adding a
   * stdio server needs the owner's confirmation; returns whether one is added.
   */
  checkBindings(profile, ids, confirmStdio) {
    if (!this.ownerManaged(profile)) throw problem(messages.agentNotEligible, 400);
    if (
      !Array.isArray(ids) ||
      ids.length > 200 ||
      ids.some((id) => typeof id !== "string" || !id)
    )
      throw problem(messages.invalidRequest, 400);
    const current = new Set(this.servers.bindings("agent", profile.id));
    const added = [...new Set(ids)].filter((id) => !current.has(id));
    // A Hermes agent gets no OAuth server: OpenClaw holds the login's tokens.
    if (ownProcess(profile) && added.some((id) => this.servers.get(id).auth === "oauth"))
      throw problem(messages.oauthHermesUnsupported, 409);
    const stdio = added.some((id) => this.servers.get(id).transport === "stdio");
    // A stdio server runs host commands; an agent with its own Telegram bot for other
    // people never gets one (like shell). Remote servers stay allowed.
    if (stdio && this.telegramSenders?.connected(profile.id))
      throw problem(messages.stdioTelegramSenders, 409);
    if (stdio) requireStdioConfirmation(confirmStdio === true);
    return stdio;
  }
  setBindings(id, ids) {
    this.servers.setBindings("agent", id, ids);
  }
  /**
   * What a Hermes agent's apply compiles into its own home (assistant-config.js):
   * `{ servers, inputs }`, its bound server ids (its own, inherited and managed ones)
   * and the store's inputs (readMcpInputs). An unreadable store binds none.
   */
  agentInputs(profile) {
    const inputs = readMcpInputs(this.servers, {
      redirectUrl: this.redirectUrl(),
      extra: this.extraInputs,
      inherited: this.inherited,
    });
    const servers = mcpEligible(profile) ? inputs.bindings[profile.id] || [] : [];
    return { servers: inputs.unreadable ? [] : servers, inputs };
  }
  // A secret-free fingerprint of what a Hermes agent's home compiles from the store.
  agentSignature(profile) {
    const { servers, inputs } = this.agentInputs(profile);
    const bound = inputs.servers.filter((server) => servers.includes(server.id));
    return createHmac("sha256", signatureKey)
      .update(
        JSON.stringify([
          servers,
          bound,
          bound.map((server) => inputs.secrets[server.id] ?? null),
        ]),
      )
      .digest("hex");
  }
  /**
   * Applies each Hermes agent whose servers changed since its last apply here: its
   * own process set compiles them into its home and restarts (assistant-config.js
   * applyOwnProcess). Rethrows the first failure after trying the others.
   */
  async applyOwnProcess() {
    const runtime = this.assistants.runtime;
    let failure = null;
    for (const profile of this.assistants.store.listAssistants()) {
      if (!ownProcess(profile) || profile.archivedAt || !runtimeAccepts(runtime, profile))
        continue;
      const signature = this.agentSignature(profile);
      if (this.applied.get(profile.id) === signature) continue;
      try {
        await this.assistants.config.apply(profile.id);
        this.applied.set(profile.id, signature);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  list() {
    return this.servers.list();
  }
  /**
   * The list with each server's agent placeholders resolved per bound agent
   * (mcp-placeholder-view.js). An unreadable state leaves the list as it is.
   */
  placeholderViews(list) {
    if (!list.some((server) => server.agentPlaceholders === true)) return list;
    try {
      const runtime = this.assistants.runtime;
      return placeholderViews(list, {
        profiles: this.assistants.store.listAssistants(),
        bindings: withInherited(this.servers.bindingsByTarget("agent"), this.inherited),
        workspaces: runtime?.paths?.workspaces ?? null,
        running: runtime?.mcp ?? null,
        // A Hermes agent's servers resolve in its own work folder.
        ownRuntime: (profile) =>
          ownProcess(profile)
            ? {
                workspace: agentWorkspace(runtime, profile),
                ready: hostReady(runtime, profile),
              }
            : null,
      });
    } catch {
      return list;
    }
  }
  /**
   * The list with the members that use each server through their lead
   * (`shared`, lead-shares.js, and `memberGrants` of task members,
   * task-member-grants.js), for the owner to see and remove. Unreadable shares leave
   * the list as it is.
   */
  sharedViews(list) {
    try {
      const shares = this.assistants.workflows?.shares?.list((row) => row.kind === "mcp");
      const granted =
        this.assistants.workflows?.memberGrants?.list((row) => row.kind === "mcp") || [];
      if (!shares?.length && !granted.length) return list;
      return list.map((server) => {
        // Task members using it through their lead (`memberGrants`, revocable too).
        const members = granted
          .filter((g) => g.serverId === server.id)
          .map((g) => ({
            id: g.id,
            agentId: g.memberAssistantId,
            agentName: g.memberName,
            leadId: g.leadId,
            leadName: g.leadName,
            bound: g.live.bound,
          }));
        server = members.length ? { ...server, memberGrants: members } : server;
        const shared = (shares || [])
          .filter((s) => s.serverId === server.id)
          .map((s) => ({
            id: s.id,
            agentId: s.memberAssistantId,
            agentName: s.memberName,
            leadId: s.leadId,
            leadName: s.leadName,
            requestId: s.requestId,
            bound: s.live.bound,
          }));
        return shared.length ? { ...server, shared } : server;
      });
    } catch {
      return list;
    }
  }
  /** `clis`: the coding CLIs the new server is bound to in the same write. */
  create(
    input,
    {
      confirmStdio = false,
      clis = [],
      pendingCommand = false,
      packageRecord = null,
      managed = null,
    } = {},
  ) {
    return this.assistants.admit(async () => {
      // A reference is refused before the owner is asked to confirm a local command.
      requireLiteralValues(input);
      if (record(input) && input.transport === "stdio")
        requireStdioConfirmation(confirmStdio === true);
      const server = this.servers.create(input, {
        bind: clis.map((cli) => ["cli", cli]),
        pendingCommand,
        packageRecord,
        managed,
      });
      // Unbound servers are not compiled; nothing to apply.
      return server;
    });
  }
  /** Whether a patch alters what a stdio server runs: command, arguments, cwd or env. */
  changesStdio(current, patch) {
    return stdioChange(current, patch);
  }
  /** `clis`, when given, replaces the server's CLI bindings in the same write. */
  update(id, input, { confirmStdio = false, clis } = {}) {
    return this.assistants.admit(async () => {
      this.servers.requireLiteralPatch(id, input);
      // A server bound to an agent with its own Telegram bot cannot become stdio.
      if (
        this.servers.get(id).transport !== "stdio" &&
        this.servers.previewUpdate(id, input).after.transport === "stdio" &&
        Object.entries(this.servers.bindingsByTarget("agent")).some(
          ([agent, ids]) => ids.includes(id) && this.telegramSenders?.connected(agent),
        )
      )
        throw problem(messages.stdioTelegramSenders, 409);
      // Editing what a stdio server runs needs the same confirmation as adding one.
      const stdioChanged = this.changesStdio(this.servers.get(id), input);
      if (stdioChanged) requireStdioConfirmation(confirmStdio === true);
      // OpenClaw keys a login by name and URL: log out under the old ones first.
      const oauth = this.oauth
        ? await this.oauth.beforeUpdate(id, this.servers.previewUpdate(id, input))
        : {};
      const server = this.servers.update(id, input, { clis });
      return {
        server,
        pending: await this.applySaved(),
        logoutDeferred: !!oauth.deferred,
        stdioChanged,
      };
    });
  }
  remove(id) {
    return this.assistants.admit(async () => {
      const { transport } = this.servers.get(id);
      const oauth = this.oauth ? await this.oauth.beforeRemove(id) : {};
      // The store removes the server's bindings with it.
      this.servers.remove(id);
      return {
        pending: await this.applySaved(),
        logoutDeferred: !!oauth.deferred,
        transport,
      };
    });
  }
  /**
   * Bounded drain of deferred OAuth logouts before a Gateway start compiles: one
   * pass that stops at the first timeout; whatever remains drains in the
   * background. Never fails the caller.
   */
  async drainLogouts() {
    try {
      // A background drain already running (for example after a rollback) covers it.
      if (!this.oauth || this.oauth.draining || !this.servers.deferredLogouts().length)
        return;
      const { remaining } = await this.oauth.drain();
      if (remaining) this.oauth.scheduleDrain(1000);
    } catch {
      // Kept for the background drain.
    }
  }
  /**
   * Applies a change that is already stored. A failed or impossible live apply is not
   * an error then: the store is the truth, `failed()` keeps the retry pending, and the
   * caller reports `pending`. Returns whether the Gateway still lags behind.
   */
  async applySaved() {
    try {
      await this.apply();
    } catch {
      // failed() recorded the failure and scheduled the retry.
    }
    return this.pending;
  }
  /**
   * Patches the running Gateway with what the store compiles now: the `mcp` block and
   * the global `tools.allow` (built with the start's helpers from the start's web
   * tools), then re-applies each agent whose MCP globs changed. Callers hold the
   * admission lock. Returns whether the Gateway was patched. Anything that keeps the
   * Gateway from converging leaves the change pending: no ready Gateway (its start
   * compiles the store), an unreadable store (never live-removes servers), a failed
   * patch or a failed agent re-apply (rethrown). Hermes agents whose servers changed
   * are applied before (applyOwnProcess).
   */
  async apply() {
    // Hermes agents need no ready OpenClaw Gateway; a failure there stays pending
    // and is rethrown once the Gateway had its turn.
    let failure = null;
    try {
      await this.applyOwnProcess();
    } catch (error) {
      failure = error;
    }
    const patched = await this.applyGateway();
    if (!failure) return patched;
    this.failed(failure);
    throw failure;
  }
  /** The OpenClaw Gateway's part of apply(). */
  async applyGateway() {
    const runtime = this.assistants.runtime;
    const running = hostReady(runtime) && runtime.mcp;
    if (!running) {
      this.pending = true;
      return false;
    }
    try {
      // Servers held back by a deferred logout are left out by readMcpInputs; the
      // logouts drain in the background, outside this lock.
      if (this.oauth && this.servers.deferredLogouts().length) this.oauth.scheduleDrain();
      // `extraInputs`: the agents' GitHub servers (agent-github.js), wired by the graph.
      const inputs = readMcpInputs(this.servers, {
        redirectUrl: this.redirectUrl(),
        extra: this.extraInputs,
        workspaces: runtime.paths?.workspaces ?? null,
        // Servers members use through their lead (lead-shares.js).
        inherited: this.inherited,
      });
      if (inputs.unreadable) {
        this.failed({ code: "MCP_STORE_UNREADABLE" });
        return false;
      }
      const profiles = this.assistants.store.listAssistants();
      const patched = await this.patch(runtime, running, profiles, inputs);
      const known = new Set(profiles.map((profile) => profile.id));
      for (const id of [...this.stale]) {
        if (known.has(id)) await this.assistants.config.apply(id);
        this.stale.delete(id);
      }
      this.settled();
      return patched;
    } catch (error) {
      this.failed(error);
      throw error;
    }
  }
  /** Patches when the compiled signature changed; marks agents whose globs changed. */
  async patch(runtime, running, profiles, inputs) {
    const { config: live } = runtimeFor(null, runtime);
    // `mcp` and `tools.allow` as a start writes them, on the start's global list with
    // its web tools, including the shell tools while some agent has shell (they
    // apply hot).
    const { snapshot, build } = live.compiler.mcpLive({
      desired: desiredState({ profiles, mcp: inputs }),
      webTools: runtime.webTools,
    });
    if (snapshot.signature === running.signature) return false;
    const adoption = live.watchAdoption(this.adoption);
    try {
      adoption.mark();
      const base = await live.patch({ build });
      // A turn admitted after the save must already see the changed MCP servers.
      const written = await live.get();
      await adoption.settle(base?.hash, written.hash);
    } finally {
      adoption.close();
    }
    const before = running.agentTools || {};
    runtime.mcp = snapshot;
    const same = (agent) =>
      JSON.stringify(before[agent] || []) ===
      JSON.stringify(snapshot.agentTools[agent] || []);
    for (const profile of profiles)
      if (!same(profile.runtimeAgentId)) this.stale.add(profile.id);
    return true;
  }
}
