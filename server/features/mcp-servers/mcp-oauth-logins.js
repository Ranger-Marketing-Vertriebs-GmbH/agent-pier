// OAuth logins of central MCP servers, driven through the OpenClaw CLI (see
// docs/mcp-oauth-qualification.md). AgentPier holds only what OpenClaw does not:
// the pending logins it started (state, server, start time; never a code or token),
// a short status cache, and per server whether it was ever connected and the
// redirect URL its last login registered.
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { patchConfig } from "../assistants/openclaw-config/live-patch.js";
import { oauthStatus } from "./openclaw-mcp-cli.js";
import { oauthLoginUsable } from "./oauth-redirect.js";

const messages = serverMessages.mcpServers;
export const pendingLoginMs = 10 * 60 * 1000;
const statusTtlMs = 10 * 1000;
// Provider errors (RFC 6749 4.1.2.1) passed through as they are; others are generic.
const providerErrors = new Set([
  "access_denied",
  "invalid_request",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_response_type",
  "server_error",
  "temporarily_unavailable",
]);

/** A refusal or failure with a stable `code` and a German catalog message. */
const failure = (message, code, status) =>
  Object.assign(problem(message, status), { code });

function cliFailure(error, redirect) {
  switch (error?.code) {
    case "cli-timeout":
      return failure(messages.oauthCliTimeout, error.code, 504);
    case "no-dynamic-registration":
      return failure(messages.oauthNoDynamicRegistration, error.code, 502);
    case "redirect-rejected":
      return failure(messages.oauthRedirectRejected(redirect), error.code, 502);
    case "session-missing":
      return failure(messages.oauthSessionMissing, error.code, 409);
    case "server-unknown":
      return failure(messages.oauthNotCompiled, "not-compiled", 409);
    case "runtime-unavailable":
      return failure(messages.oauthRuntimeUnavailable, error.code, 503);
    default:
      return failure(messages.oauthLoginFailed, error?.code || "cli-failed", 502);
  }
}

/**
 * The next `mcp.sessionIdleTtlMs`: a hot change under `mcp` that changes nothing
 * else. Unset and 0 mean the same (MCP runtimes live until their session ends), so
 * the default toggles between them; an owner's positive value moves by 1 ms.
 */
export function nudgedIdleTtl(current) {
  if (current === 0) return null;
  if (Number.isSafeInteger(current) && current > 0)
    return current % 2 ? current + 1 : current - 1;
  return 0;
}

export class McpOAuthLogins {
  /**
   * - `cli`: openclaw-mcp-cli wrapper (startLogin, completeLogin, logout, status).
   * - `servers`: the McpServerStore.
   * - `runtime`: the RuntimeSupervisor (`mcp` snapshot, `client`).
   * - `admit(operation)`: the assistants' admission lock for live config writes.
   * - `isCurrent()`: false while a stored MCP change still waits to be applied.
   * - `remoteUrl()`: the configured HTTPS remote origin, if any.
   */
  constructor({
    cli,
    servers,
    runtime,
    admit = (operation) => operation(),
    isCurrent = () => true,
    remoteUrl = () => null,
    now = Date.now,
    warn = console.warn,
  }) {
    Object.assign(this, {
      cli,
      servers,
      runtime,
      admit,
      isCurrent,
      remoteUrl,
      now,
      warn,
    });
    this.pending = new Map(); // state -> { serverId, name, state, startedAt }
    this.queues = new Map(); // name -> tail of its serialized CLI calls
    this.cache = null; // { at, promise }
  }

  /** Runs `operation` after every earlier CLI call for `name`. */
  serial(name, operation) {
    const previous = this.queues.get(name) || Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.catch(() => {});
    this.queues.set(name, tail);
    tail.then(() => {
      if (this.queues.get(name) === tail) this.queues.delete(name);
    });
    return result;
  }

  invalidate() {
    this.cache = null;
  }

  /** Whether the running Gateway compiled `name` (the CLI reads its config). */
  compiled(name) {
    return !!this.runtime?.mcp?.servers?.includes(name);
  }

  /** The unexpired pending login of `serverId`, pruning expired ones. */
  pendingFor(serverId) {
    let found = null;
    for (const [state, login] of this.pending) {
      if (this.now() - login.startedAt >= pendingLoginMs) this.pending.delete(state);
      else if (login.serverId === serverId) found = login;
    }
    return found;
  }

  dropPending(serverId) {
    for (const [state, login] of this.pending)
      if (login.serverId === serverId) this.pending.delete(state);
  }

  /**
   * Starts a login for server `id` from a browser on `requestOrigin`. Returns
   * `{ authorizationUrl }`, or `{ connected: true }` when OpenClaw only refreshed.
   * Refuses before running the CLI when the browser could not reach the redirect.
   */
  async start(id, { requestOrigin } = {}) {
    const server = this.servers.get(id);
    if (server.transport === "stdio" || server.auth !== "oauth")
      throw failure(messages.oauthNotOAuth, "not-oauth", 409);
    const usable = oauthLoginUsable({ requestOrigin, remoteUrl: this.remoteUrl() });
    if (!usable.usable)
      throw failure(
        usable.reason === "loopback-redirect"
          ? messages.oauthLoopbackRedirect
          : messages.oauthPlainHttpRemote,
        usable.reason,
        409,
      );
    const redirect = this.runtime?.mcp?.redirectUrl;
    if (!redirect || !this.compiled(server.name) || !this.isCurrent())
      throw failure(messages.oauthNotCompiled, "not-compiled", 409);
    const name = server.name;
    const result = await this.serial(name, async () => {
      // A second start replaces the first: its state no longer completes.
      this.dropPending(id);
      try {
        // OpenClaw registered the client for the redirect of the last login; a
        // changed redirect needs a new registration, which a logout forces.
        const { loginRedirect } = this.servers.oauthMemory(id);
        if (loginRedirect && loginRedirect !== redirect) await this.logoutQuietly(name);
        const started = await this.cli.startLogin(name);
        this.servers.rememberOAuth(id, { loginRedirect: redirect });
        if (started.authorized) {
          this.servers.rememberOAuth(id, { connected: true });
          return { connected: true };
        }
        this.pending.set(started.state, {
          serverId: id,
          name,
          state: started.state,
          startedAt: this.now(),
        });
        return { authorizationUrl: started.authorizationUrl };
      } catch (error) {
        throw error?.name === "McpCliError" ? cliFailure(error, redirect) : error;
      } finally {
        this.invalidate();
      }
    });
    if (result.connected) await this.resetBackoff();
    return result;
  }

  /** Logs out `name`; a server OpenClaw does not know has nothing to log out. */
  async logoutQuietly(name) {
    try {
      await this.cli.logout(name);
    } catch (error) {
      if (error?.code !== "server-unknown") throw error;
    }
  }

  /**
   * Completes the login the provider redirected back with (`state`, `code` or
   * `error`). A state that is unknown, expired, already used or replaced fails with
   * status 400 and runs nothing. Returns `{ serverId, result: "connected" }` or
   * `{ serverId, result: "error", reason }` with a stable reason.
   */
  async complete({ state, code, error } = {}) {
    const login = typeof state === "string" ? this.pending.get(state) : undefined;
    // Single use: consumed before anything runs.
    if (login) this.pending.delete(state);
    let current = null;
    try {
      current = login && this.servers.get(login.serverId);
    } catch {
      current = null;
    }
    if (
      !login ||
      this.now() - login.startedAt >= pendingLoginMs ||
      !current ||
      current.name !== login.name ||
      current.auth !== "oauth"
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
      await this.serial(login.name, () => this.cli.completeLogin(login.name, code));
    } catch (failed) {
      return { serverId, result: "error", reason: failed?.code || "cli-failed" };
    } finally {
      this.invalidate();
    }
    this.servers.rememberOAuth(serverId, { connected: true });
    await this.resetBackoff();
    return { serverId, result: "connected" };
  }

  /**
   * A successful `--code` does not lift OpenClaw's failed-start backoff; any hot
   * change under `mcp` does (qualification (b)). Failures are logged: the login
   * stands, the tools follow at the latest after the backoff.
   */
  async resetBackoff() {
    const runtime = this.runtime;
    if (!runtime?.client?.ready || !runtime.mcp) return false;
    try {
      await this.admit(async () => {
        if (!runtime.client?.ready) return;
        await patchConfig(runtime.client, (config) => ({
          patch: {
            mcp: { sessionIdleTtlMs: nudgedIdleTtl(config.mcp?.sessionIdleTtlMs) },
          },
        }));
      });
      return true;
    } catch (error) {
      this.warn(
        `MCP servers could not be reloaded after an OAuth login (${
          error?.code || error?.name || "ERROR"
        }).`,
      );
      return false;
    }
  }

  /** Logs server `id` out (owner action). */
  async logout(id) {
    const server = this.servers.get(id);
    if (server.transport === "stdio" || server.auth !== "oauth")
      throw failure(messages.oauthNotOAuth, "not-oauth", 409);
    this.dropPending(id);
    if (!this.compiled(server.name))
      throw failure(messages.oauthNotCompiled, "not-compiled", 409);
    try {
      await this.serial(server.name, () => this.logoutQuietly(server.name));
    } catch (error) {
      throw cliFailure(error, this.runtime?.mcp?.redirectUrl);
    } finally {
      this.invalidate();
    }
  }

  /**
   * Before a change moves the login elsewhere (rename, URL change, switch to
   * headers, delete): logs out under the old name while OpenClaw can still address
   * it. A server the running Gateway did not compile cannot be addressed and is
   * skipped. A server OpenClaw does not know has nothing to log out; any other
   * failure blocks the change, so no login is orphaned silently.
   */
  async forget(id, name) {
    this.dropPending(id);
    if (!this.compiled(name)) return;
    try {
      await this.serial(name, () => this.logoutQuietly(name));
    } catch (error) {
      this.warn(
        `An MCP server's OAuth login could not be removed (${error?.code || "ERROR"}).`,
      );
      throw failure(messages.oauthLogoutFailed, "logout-failed", 409);
    } finally {
      this.invalidate();
    }
  }

  /** Called with the store's previewUpdate before an update is saved. */
  async beforeUpdate(id, { before, after }) {
    if (before.auth !== "oauth") return;
    if (after.auth === "oauth" && before.name === after.name && before.url === after.url)
      return;
    await this.forget(id, before.name);
  }

  /** Called before server `id` is deleted. */
  async beforeRemove(id) {
    const server = this.servers.get(id);
    if (server.auth === "oauth" && server.transport !== "stdio")
      await this.forget(id, server.name);
  }

  /** `openclaw mcp status` by name, cached briefly; {} when nothing is compiled. */
  statuses(names) {
    if (!names.some((name) => this.compiled(name))) return Promise.resolve({});
    if (this.cache && this.now() - this.cache.at < statusTtlMs) return this.cache.promise;
    const promise = this.cli.status();
    this.cache = { at: this.now(), promise };
    return promise;
  }

  /**
   * The server list with `oauthStatus` ("connected", "login-pending",
   * "login-required", "not-connected", or "unknown" when OpenClaw could not be
   * asked) and `oauthExpiresAt` on OAuth servers.
   */
  async decorate(list) {
    const oauth = list.filter((s) => s.auth === "oauth" && s.transport !== "stdio");
    if (!oauth.length) return list;
    let statuses = null;
    try {
      statuses = await this.statuses(oauth.map((s) => s.name));
    } catch {
      statuses = null;
    }
    return list.map((server) => {
      if (!oauth.includes(server)) return server;
      if (!statuses) return { ...server, oauthStatus: "unknown" };
      let everConnected = false;
      try {
        everConnected = this.servers.oauthMemory(server.id).everConnected;
      } catch {
        everConnected = false;
      }
      const auth = statuses[server.name];
      const status = oauthStatus(auth, {
        pendingLogin: !!this.pendingFor(server.id),
        everConnected,
      });
      return {
        ...server,
        oauthStatus: status,
        ...(status === "connected" && auth?.expiresAt
          ? { oauthExpiresAt: auth.expiresAt }
          : {}),
      };
    });
  }
}
