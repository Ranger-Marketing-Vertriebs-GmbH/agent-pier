import { assistantProblem } from "../assistants/assistant-validation.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { cliTargets, requireCliSupport } from "./cli-native.js";
import { changesStdio, requireStdioConfirmation } from "./stdio-confirmation.js";

/**
 * The owner's central MCP servers, with or without agents. With agents each change
 * goes through McpChanges (admission, OpenClaw logouts, live apply). Without them the
 * store changes directly; a login OpenClaw may still hold under a server's old name or
 * address becomes a deferred logout, which the next Gateway start drains before it
 * compiles. `onSaved` runs after every stored change (the CLI reconciliation).
 * A change can carry the coding CLIs the server goes to (`options.clis`): they are
 * checked with the definition and stored in the same write, so a refusal changes
 * neither, and the CLIs are reconciled only after both were stored.
 */
export class CentralMcpChanges {
  constructor({
    servers,
    agents = () => null,
    maintenance = () => false,
    onSaved = async () => {},
  }) {
    Object.assign(this, { servers, agents, maintenance, onSaved });
  }
  list() {
    return this.servers.list();
  }
  /** Agents in maintenance refuse changes, as their routes always did. */
  admit() {
    if (this.maintenance()) throw assistantProblem("active", 409);
    return this.agents();
  }
  /**
   * The CLIs a change ends with (`wanted`, else the bound ones) and those it adds.
   * Refuses a CLI that cannot run `definition`, and a local command newly given to a
   * CLI without the owner's confirmation.
   */
  cliChange(definition, bound, wanted, confirmStdio) {
    const next = wanted === undefined ? bound : cliTargets(wanted);
    requireCliSupport(next, definition);
    const added = next.filter((cli) => !bound.includes(cli));
    if (definition.transport === "stdio" && added.length)
      requireStdioConfirmation(confirmStdio === true);
    return { clis: next, added };
  }
  /** Stores a new server; `options.clis` binds it to coding CLIs in the same write. */
  async create(input, { clis: wanted, ...options } = {}) {
    const agents = this.admit();
    const clis =
      wanted === undefined || !record(input)
        ? []
        : this.cliChange(input, [], wanted, options.confirmStdio).clis;
    let server;
    if (agents) server = await agents.create(input, { ...options, clis });
    else {
      if (record(input) && input.transport === "stdio")
        requireStdioConfirmation(options.confirmStdio === true);
      server = this.servers.create(input, { bind: clis.map((cli) => ["cli", cli]) });
    }
    await this.onSaved();
    return server;
  }
  /**
   * Updates a server; `options.clis` replaces its CLI bindings in the same write.
   * A change a bound CLI cannot run is refused, never its entry silently removed.
   * `cliChange` is `{ clis, added }` when the change carried CLIs.
   */
  async update(id, input, { clis: wanted, ...options } = {}) {
    const agents = this.admit();
    const bound = this.servers.targetsOf(id).clis;
    let change = null;
    if (bound.length || wanted !== undefined) {
      const { after } = this.servers.previewUpdate(id, input);
      change = this.cliChange(after, bound, wanted, options.confirmStdio);
    }
    const clis = wanted === undefined ? undefined : change.clis;
    const result = agents
      ? await agents.update(id, input, { ...options, clis })
      : this.updateDirect(id, input, { ...options, clis });
    await this.onSaved();
    return { ...result, cliChange: wanted === undefined ? null : change };
  }
  async remove(id) {
    const agents = this.admit();
    const result = agents ? await agents.remove(id) : this.removeDirect(id);
    await this.onSaved();
    return result;
  }
  updateDirect(id, input, { confirmStdio = false, clis } = {}) {
    const stdioChanged = changesStdio(this.servers.get(id), input);
    if (stdioChanged) requireStdioConfirmation(confirmStdio === true);
    const { before, after } = this.servers.previewUpdate(id, input);
    const orphaned =
      before.auth === "oauth" &&
      !(
        after.auth === "oauth" &&
        before.name === after.name &&
        before.url === after.url
      ) &&
      this.servers.oauthMemory(id).everConnected;
    const server = this.servers.update(id, input, { clis });
    if (orphaned) {
      this.servers.deferLogout(before);
      // As McpOAuthLogins.forget: the login under the old name and URL is gone.
      this.servers.rememberOAuth(id, { connected: false, loginRedirect: null });
    }
    return { server, pending: false, logoutDeferred: orphaned, stdioChanged };
  }
  removeDirect(id) {
    const definition = this.servers.definitions().find((item) => item.id === id);
    if (!definition) throw problem(serverMessages.mcpServers.notFound, 404);
    const orphaned =
      definition.transport !== "stdio" &&
      definition.auth === "oauth" &&
      this.servers.oauthMemory(id).everConnected;
    this.servers.remove(id);
    if (orphaned) this.servers.deferLogout(definition);
    return { pending: false, logoutDeferred: orphaned, transport: definition.transport };
  }
}
