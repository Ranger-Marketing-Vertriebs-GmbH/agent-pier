import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { patchConfig } from "./openclaw-config/live-patch.js";
import { watchConfigAdoption } from "./openclaw-config/config-adoption.js";
import {
  applyMcp,
  mcpEligible,
  mcpSections,
  mcpSnapshot,
  readMcpInputs,
} from "./openclaw-config/mcp-servers.js";
import { applyShell, shellSections } from "./openclaw-config/shell.js";
import { placeholderViews } from "./mcp-placeholder-view.js";
import { nativeTools } from "./runtime-config.js";
import { temporaryMember } from "./team-presentation.js";
import {
  STDIO_CONFIRMATION_REQUIRED,
  changesStdio as stdioChange,
  requireStdioConfirmation,
} from "../mcp-servers/stdio-confirmation.js";
import { requireLiteralValues } from "../mcp-servers/value-references.js";

export { STDIO_CONFIRMATION_REQUIRED };

const messages = serverMessages.mcpServers;
// Compiled server names; anything else cannot be addressed as a dotted path.
const pathName = /^[A-Za-z][A-Za-z0-9_-]{0,29}$/;
// Retry delays of a failed live apply: doubling from one second to one minute.
const firstRetryMs = 1000;
const lastRetryMs = 60000;

/**
 * A JSON merge patch from `current` to `target`: keys `target` lacks become null.
 * Redacted secret values in `current` never equal the real ones, so they are
 * always rewritten.
 */
function mergeDiff(current, target) {
  const patch = {};
  for (const key of Object.keys(current)) if (!(key in target)) patch[key] = null;
  for (const [key, value] of Object.entries(target))
    patch[key] =
      record(value) && record(current[key]) ? mergeDiff(current[key], value) : value;
  return patch;
}

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
        bindings: this.servers.bindingsByTarget("agent"),
        workspaces: runtime?.paths?.workspaces ?? null,
        running: runtime?.mcp ?? null,
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
   * patch or a failed agent re-apply (rethrown).
   */
  async apply() {
    const runtime = this.assistants.runtime;
    const running = runtime.client?.ready && runtime.mcp;
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
    const sections = mcpSections({ profiles, ...inputs });
    const snapshot = mcpSnapshot(sections);
    if (snapshot.signature === running.signature) return false;
    // applyMcp on the start's global list: `mcp` and `tools.allow` as a start writes,
    // including the shell tools while some agent has shell (they apply hot).
    const global = {
      tools: { allow: [...nativeTools, ...(runtime.webTools?.tools || [])] },
    };
    const target = applyMcp(applyShell(global, shellSections({ profiles })), sections);
    const adoption = watchConfigAdoption(runtime.client, this.adoption);
    try {
      adoption.mark();
      const base = await patchConfig(runtime.client, (config) => {
        const current = record(config.mcp?.servers) ? config.mcp.servers : {};
        const servers = target.mcp?.servers || {};
        const patch = { tools: { allow: target.tools.allow } };
        if (Object.keys(current).length || Object.keys(servers).length)
          patch.mcp = { servers: mergeDiff(current, servers) };
        // A merge patch cannot shorten or drop an array; OpenClaw needs each one listed.
        const arrays = Object.entries(current)
          .filter(([name, server]) => pathName.test(name) && Array.isArray(server?.args))
          .map(([name]) => `mcp.servers.${name}.args`);
        return { patch, replacePaths: ["tools.allow", ...arrays] };
      });
      // A turn admitted after the save must already see the changed MCP servers.
      const written = await runtime.client.call("config.get", {});
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
