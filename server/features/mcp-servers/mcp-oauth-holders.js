import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { providerErrors } from "./mcp-oauth-logins.js";
import { oauthLoginUsable } from "./oauth-redirect.js";

const messages = serverMessages.mcpServers;
const failure = (message, code, status) =>
  Object.assign(problem(message, status), { code });

/**
 * MCP OAuth logins by holder, behind one interface (routes, McpChanges, the server
 * list):
 * - AgentPier (`agentpier`, mcp-oauth-agentpier.js) runs every new login of a
 *   Streamable HTTP server and holds its tokens; both runtimes then reach it through
 *   the MCP proxy (mcp-proxy.js). Its first completed login also removes OpenClaw's
 *   own login of that server, so a server never has two refreshers.
 * - OpenClaw (`legacy`, McpOAuthLogins over its CLI) keeps the logins it made before,
 *   until the owner signs in again, and the logins of SSE servers, which the proxy
 *   does not carry.
 */
export class McpOAuthHolders {
  constructor({
    legacy,
    agentpier,
    servers,
    admit = (operation) => operation(),
    redirectUrl,
    remoteUrl = () => null,
    reapply = null,
    warn = console.warn,
  }) {
    Object.assign(this, {
      legacy,
      agentpier,
      servers,
      admit,
      redirectUrl,
      remoteUrl,
      reapply,
      warn,
    });
  }
  // A server whose login AgentPier runs: Streamable HTTP with OAuth.
  ours(server) {
    return !!this.agentpier && server?.auth === "oauth" && server.transport === "http";
  }
  held(id) {
    return !!this.agentpier?.held(id);
  }
  async start(id, { requestOrigin } = {}) {
    const server = this.servers.get(id);
    if (!this.ours(server)) return this.legacy.start(id, { requestOrigin });
    const usable = oauthLoginUsable({ requestOrigin, remoteUrl: this.remoteUrl() });
    if (!usable.usable)
      throw failure(
        usable.reason === "loopback-redirect"
          ? messages.oauthLoopbackRedirect
          : messages.oauthPlainHttpRemote,
        usable.reason,
        409,
      );
    const definition = this.legacy.definition(id);
    let started;
    try {
      started = await this.agentpier.start(definition, {
        redirectUrl: this.redirectUrl(),
      });
    } catch (error) {
      this.warn(
        `An MCP server's OAuth login could not start (${error?.cause?.name || error?.code || "ERROR"}).`,
      );
      throw failure(messages.oauthLoginFailed, "oauth-failed", 502);
    }
    if (started.connected) {
      await this.adopted(definition);
      return { connected: true };
    }
    return { authorizationUrl: started.authorizationUrl };
  }
  async complete({ state, code, error } = {}) {
    const login = this.agentpier?.take(state);
    if (!login) return this.legacy.complete({ state, code, error });
    let definition = null;
    try {
      definition = this.legacy.definition(login.serverId);
    } catch {
      definition = null;
    }
    if (
      !definition ||
      definition.name !== login.name ||
      definition.url !== login.url ||
      !this.ours(definition)
    )
      throw failure(messages.oauthStateInvalid, "state-invalid", 400);
    const serverId = login.serverId;
    if (error !== undefined)
      return {
        serverId,
        result: "error",
        reason: providerErrors.has(error) ? error : "provider-error",
      };
    if (typeof code !== "string" || !code)
      return { serverId, result: "error", reason: "code-missing" };
    try {
      await this.agentpier.complete(login, definition, code);
    } catch {
      return { serverId, result: "error", reason: "oauth-failed" };
    }
    await this.adopted(definition);
    return { serverId, result: "connected" };
  }
  /**
   * After AgentPier's login of `definition`: OpenClaw's own login of that server goes
   * (deferred and retried when its CLI fails), and both runtimes compile the proxy.
   */
  async adopted(definition) {
    let openclaw = false;
    try {
      openclaw = this.servers.oauthMemory(definition.id).everConnected;
    } catch {
      openclaw = false;
    }
    if (openclaw) await this.legacy.forget(definition.id, definition).catch(() => {});
    this.legacy.invalidate();
    try {
      await this.admit(() => this.reapply?.());
    } catch (error) {
      this.warn(
        `MCP servers could not be applied after an OAuth login (${error?.code || "ERROR"}).`,
      );
    }
    await this.legacy.resetBackoff();
  }
  async logout(id) {
    const server = this.servers.get(id);
    if (!this.held(id)) return this.legacy.logout(id);
    if (server.transport === "stdio" || server.auth !== "oauth")
      throw failure(messages.oauthNotOAuth, "not-oauth", 409);
    this.agentpier.logout(id);
  }
  /** A changed name, URL, transport or auth needs a new login at AgentPier. */
  async beforeUpdate(id, change) {
    if (!this.held(id)) return this.legacy.beforeUpdate(id, change);
    const { before, after } = change;
    if (
      !this.ours(after) ||
      before.name !== after.name ||
      before.url !== after.url ||
      before.oauthScope !== after.oauthScope
    )
      this.agentpier.forget(id);
    return { deferred: false };
  }
  async beforeRemove(id) {
    if (!this.held(id)) return this.legacy.beforeRemove(id);
    this.agentpier.forget(id);
    return { deferred: false };
  }
  /** The list with `oauthStatus`, `oauthExpiresAt` and `oauthHolder` on OAuth servers. */
  async decorate(list) {
    const held = new Set(list.filter((s) => this.held(s.id)).map((s) => s.id));
    const legacy = await this.legacy.decorate(list.filter((s) => !held.has(s.id)));
    const byId = new Map(legacy.map((s) => [s.id, s]));
    let definitions = [];
    if (held.size)
      try {
        definitions = this.servers.definitions();
      } catch {
        definitions = [];
      }
    return list.map((server) => {
      if (!held.has(server.id)) {
        const decorated = byId.get(server.id) || server;
        // A login OpenClaw holds: signing in again moves it to AgentPier.
        return decorated.oauthStatus === "connected" && this.ours(server)
          ? { ...decorated, oauthHolder: "openclaw" }
          : decorated;
      }
      const definition = definitions.find((d) => d.id === server.id);
      return {
        ...server,
        ...(definition ? this.agentpier.status(definition) : { oauthStatus: "unknown" }),
        oauthHolder: "agentpier",
      };
    });
  }
  afterRollback(since) {
    return this.legacy.afterRollback(since);
  }
  scheduleDrain(delay) {
    return this.legacy.scheduleDrain(delay);
  }
  invalidate() {
    return this.legacy.invalidate();
  }
  close() {
    return this.legacy.close();
  }
}
