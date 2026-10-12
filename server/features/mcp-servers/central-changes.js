import { assistantProblem } from "../assistants/assistant-validation.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { changesStdio, requireStdioConfirmation } from "./stdio-confirmation.js";

/**
 * The owner's central MCP servers, with or without agents. With agents each change
 * goes through McpChanges (admission, OpenClaw logouts, live apply). Without them the
 * store changes directly; a login OpenClaw may still hold under a server's old name or
 * address becomes a deferred logout, which the next Gateway start drains before it
 * compiles. `onSaved` runs after every stored change (the CLI reconciliation).
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
  async create(input, options = {}) {
    const agents = this.admit();
    let server;
    if (agents) server = await agents.create(input, options);
    else {
      if (record(input) && input.transport === "stdio")
        requireStdioConfirmation(options.confirmStdio === true);
      server = this.servers.create(input);
    }
    await this.onSaved();
    return server;
  }
  async update(id, input, options = {}) {
    const agents = this.admit();
    const result = agents
      ? await agents.update(id, input, options)
      : this.updateDirect(id, input, options);
    await this.onSaved();
    return result;
  }
  async remove(id) {
    const agents = this.admit();
    const result = agents ? await agents.remove(id) : this.removeDirect(id);
    await this.onSaved();
    return result;
  }
  updateDirect(id, input, { confirmStdio = false } = {}) {
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
    const server = this.servers.update(id, input);
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
