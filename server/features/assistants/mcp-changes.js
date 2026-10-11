import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { patchConfig } from "./openclaw-config/live-patch.js";
import {
  applyMcp,
  mcpEligible,
  mcpSections,
  mcpSnapshot,
  readMcpInputs,
} from "./openclaw-config/mcp-servers.js";
import { nativeTools } from "./runtime-config.js";
import { temporaryMember } from "./team-presentation.js";

const messages = serverMessages.mcpServers;
export const STDIO_CONFIRMATION_REQUIRED = "MCP_STDIO_CONFIRMATION_REQUIRED";
// Compiled server names; anything else cannot be addressed as a dotted path.
const pathName = /^[A-Za-z][A-Za-z0-9_-]{0,29}$/;

const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** Refuses a stdio server the owner has not confirmed; nothing is persisted then. */
function requireStdioConfirmation(confirmed) {
  if (!confirmed)
    throw Object.assign(problem(messages.stdioConfirmationRequired, 409), {
      code: STDIO_CONFIRMATION_REQUIRED,
    });
}

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
  constructor({ assistants, servers }) {
    Object.assign(this, { assistants, servers });
  }
  /** Personal agents and permanent members; temporary members get team bindings. */
  ownerManaged(profile) {
    return mcpEligible(profile) && !temporaryMember(profile);
  }
  /** The profile as responses show it: with its bound server ids when owner-managed. */
  decorate(profile) {
    if (!profile || !this.ownerManaged(profile)) return profile;
    return { ...profile, mcpServers: this.servers.bindings("agent", profile.id) };
  }
  /**
   * Validates a new binding set for `profile` before anything is persisted. Adding a
   * stdio server needs the owner's confirmation.
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
    if (stdio) requireStdioConfirmation(confirmStdio === true);
  }
  setBindings(id, ids) {
    this.servers.setBindings("agent", id, ids);
  }
  list() {
    return this.servers.list();
  }
  create(input, { confirmStdio = false } = {}) {
    return this.assistants.admit(async () => {
      if (record(input) && input.transport === "stdio")
        requireStdioConfirmation(confirmStdio === true);
      const server = this.servers.create(input);
      // Unbound servers are not compiled; nothing to apply.
      return server;
    });
  }
  update(id, input) {
    return this.assistants.admit(async () => {
      const server = this.servers.update(id, input);
      await this.apply();
      return server;
    });
  }
  remove(id) {
    return this.assistants.admit(async () => {
      // The store removes the server's bindings with it.
      this.servers.remove(id);
      await this.apply();
    });
  }
  /**
   * Patches the running Gateway with what the store compiles now: the `mcp` block and
   * the global `tools.allow` (built with the start's helpers from the start's web
   * tools), then re-applies each agent whose MCP globs changed. Callers hold the
   * admission lock. Returns whether the Gateway was patched.
   */
  async apply() {
    const runtime = this.assistants.runtime;
    const running = runtime.client?.ready && runtime.mcp;
    if (!running) return false;
    const store = this.assistants.store;
    const profiles = store.listAssistants();
    const sections = mcpSections({ profiles, ...readMcpInputs(this.servers) });
    const snapshot = mcpSnapshot(sections);
    if (snapshot.signature === running.signature) return false;
    // applyMcp on the start's global list: `mcp` and `tools.allow` as a start writes.
    const target = applyMcp(
      { tools: { allow: [...nativeTools, ...(runtime.webTools?.tools || [])] } },
      sections,
    );
    await patchConfig(runtime.client, (config) => {
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
    const before = running.agentTools || {};
    runtime.mcp = snapshot;
    const changed = new Set(
      [...Object.keys(before), ...Object.keys(snapshot.agentTools)].filter(
        (agent) =>
          JSON.stringify(before[agent] || []) !==
          JSON.stringify(snapshot.agentTools[agent] || []),
      ),
    );
    for (const profile of profiles)
      if (changed.has(profile.runtimeAgentId))
        await this.assistants.config.apply(profile.id);
    return true;
  }
}
