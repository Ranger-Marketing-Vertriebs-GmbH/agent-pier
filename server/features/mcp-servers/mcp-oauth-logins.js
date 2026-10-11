// OAuth logins of central MCP servers, driven through the OpenClaw CLI (see
// docs/mcp-oauth-qualification.md). AgentPier holds only what OpenClaw does not:
// the pending logins it started (state, server, start time; never a code or token),
// a short status cache, per server whether it was ever connected and the redirect
// URL its last login registered, and logouts that failed and are retried later.
import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { problem } from "../../lib/storage.js";
import { patchConfig } from "../assistants/openclaw-config/live-patch.js";
import {
  mcpServerConfig,
  mcpServerSignature,
} from "../assistants/openclaw-config/mcp-servers.js";
import { oauthStatus } from "./openclaw-mcp-cli.js";
import { oauthCallbackPath, oauthLoginUsable } from "./oauth-redirect.js";

const messages = serverMessages.mcpServers;
export const pendingLoginMs = 10 * 60 * 1000;
const statusTtlMs = 10 * 1000;
const firstDrainMs = 1000;
const lastDrainMs = 10 * 60 * 1000;
// Failures that would fail every further logout the same way.
const stalls = new Set(["cli-timeout", "runtime-unavailable"]);
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

/**
 * Whether a deferred logout `{ name, url }` matches the OAuth server `definition`:
 * OpenClaw keys logins by name and URL, so such a server must not be compiled until
 * the logout went through.
 */
export function heldByLogout(definition, deferred) {
  return (
    definition?.auth === "oauth" &&
    definition.transport !== "stdio" &&
    deferred.some((t) => t.name === definition.name && t.url === definition.url)
  );
}

export class McpOAuthLogins {
  /**
   * - `cli`: openclaw-mcp-cli wrapper (startLogin, completeLogin, logout, status).
   * - `servers`: the McpServerStore.
   * - `runtime`: the RuntimeSupervisor (`mcp` snapshot, `client`).
   * - `admit(operation)`: the assistants' admission lock (store edits, config writes).
   * - `redirectUrl()`: the redirect URL the store compiles OAuth servers with now.
   * - `remoteUrl()`: the configured HTTPS remote origin, if any.
   * - `reapply()`: applies the store now (called while admitted).
   * - `onFreed()`: applies the store after a background drain freed a server.
   */
  constructor({
    cli,
    servers,
    runtime,
    admit = (operation) => operation(),
    redirectUrl = () => runtime?.mcp?.redirectUrl ?? null,
    remoteUrl = () => null,
    reapply = null,
    onFreed = null,
    now = Date.now,
    warn = console.warn,
  }) {
    Object.assign(this, {
      cli,
      servers,
      runtime,
      admit,
      redirectUrl,
      remoteUrl,
      reapply,
      onFreed,
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

  /** The unredacted definition of server `id` (throws 404 like the store). */
  definition(id) {
    this.servers.get(id);
    return this.servers.definitions().find((server) => server.id === id);
  }

  /**
   * Whether the running Gateway carries this server exactly as the store compiles
   * it now. A change still waiting to be applied to this server (name, URL, scope or
   * redirect) refuses its login; changes to other servers do not.
   */
  current(definition) {
    const signature = this.runtime?.mcp?.serverSignatures?.[definition.name];
    const config = mcpServerConfig(definition, null, this.redirectUrl());
    return !!signature && !!config && signature === mcpServerSignature(config);
  }

  /** Whether a deferred logout for its name and URL keeps `definition` uncompiled. */
  held(definition) {
    return heldByLogout(definition, this.servers.deferredLogouts());
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
   * Clears OpenClaw's login for `{ name, url, transport }` under a one-server config,
   * so it works whether or not the Gateway compiles that name now. A server OpenClaw
   * does not know has nothing to log out. Callers serialize by name.
   */
  async clearLogin(target) {
    const server = mcpServerConfig(
      { ...target, auth: "oauth" },
      null,
      this.redirectUrl() || `http://127.0.0.1${oauthCallbackPath}`,
    );
    try {
      await this.cli.logout(target.name, server ? { server } : {});
    } catch (error) {
      if (error?.code !== "server-unknown") throw error;
    }
    // A rollback to an earlier update snapshot would bring this login back.
    this.servers.recordLogout(target, this.now());
  }

  /**
   * After a runtime update rollback restored OpenClaw's state of `since` (the
   * snapshot time): every login cleared since then is logged out again before the
   * Gateway starts. Each becomes a deferred logout, which keeps a server with that
   * name and URL uncompiled until the drain cleared it. Without a known snapshot
   * time every remembered logout is repeated.
   */
  afterRollback(since) {
    const from = Number.isSafeInteger(since) ? since : 0;
    for (const target of this.servers.logoutsSince(from))
      this.servers.deferLogout(target);
    this.invalidate();
    if (this.servers.deferredLogouts().length) this.scheduleDrain(0);
  }

  /**
   * Starts a login for server `id` from a browser on `requestOrigin`. Returns
   * `{ authorizationUrl }`, or `{ connected: true }` when OpenClaw only refreshed.
   * Refuses before running the CLI when the browser could not reach the redirect.
   * Runs under the admission lock, so no edit can rename or move the server between
   * its checks and the CLI.
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
    const result = await this.admit(() => this.startAdmitted(id));
    if (result.connected) await this.resetBackoff();
    return result;
  }

  async startAdmitted(id) {
    let definition = this.definition(id);
    // A login an earlier logout could not clear must go first: until then the
    // server is not compiled, so old tokens never come back under its name and URL.
    if (this.held(definition)) {
      const target = this.servers
        .deferredLogouts()
        .find((t) => heldByLogout(definition, [t]));
      try {
        await this.serial(target.name, () => this.clearLogin(target));
      } catch {
        this.scheduleDrain();
        throw failure(messages.oauthLogoutFailed, "logout-failed", 409);
      } finally {
        this.invalidate();
      }
      this.servers.settleLogout(target);
      // Compiles the server it freed (McpChanges.apply; admitted like this start).
      try {
        await this.reapply?.();
      } catch {
        // Judged by current() below.
      }
      definition = this.definition(id);
    }
    const name = definition.name;
    const redirect = this.runtime?.mcp?.redirectUrl;
    if (definition.auth !== "oauth" || !redirect || !this.current(definition))
      throw failure(messages.oauthNotCompiled, "not-compiled", 409);
    return this.serial(name, async () => {
      // A second start replaces the first: its state no longer completes.
      this.dropPending(id);
      try {
        // OpenClaw registered the client for the redirect of the last login; a
        // changed redirect needs a new registration, which a logout forces.
        const { loginRedirect } = this.servers.oauthMemory(id);
        if (loginRedirect && loginRedirect !== redirect)
          await this.clearLogin(definition);
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
  }

  /**
   * Completes the login the provider redirected back with (`state`, `code` or
   * `error`). A state that is unknown, expired, already used or replaced fails with
   * status 400 and runs nothing. Returns `{ serverId, result: "connected" }` or
   * `{ serverId, result: "error", reason }` with a stable reason.
   */
  async complete({ state, code, error } = {}) {
    const login = typeof state === "string" ? this.pending.get(state) : undefined;
    // Single use: consumed synchronously, before anything awaits.
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
   * change under `mcp` does (qualification (b)). It disposes the MCP runtimes of
   * every session once, which is acceptable once per login. Failures are logged: the
   * login stands, the tools follow at the latest after the backoff.
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
    const definition = this.definition(id);
    if (definition.transport === "stdio" || definition.auth !== "oauth")
      throw failure(messages.oauthNotOAuth, "not-oauth", 409);
    this.dropPending(id);
    try {
      await this.serial(definition.name, () => this.clearLogin(definition));
    } catch (error) {
      throw cliFailure(error, this.runtime?.mcp?.redirectUrl);
    } finally {
      this.invalidate();
    }
    this.servers.rememberOAuth(id, { connected: false, loginRedirect: null });
  }

  /**
   * Before a change moves the login elsewhere (rename, URL change, switch to
   * headers, delete): clears it under the old name and URL. The owner is never
   * blocked: a logout that fails is recorded and retried (drain), and the result
   * says so with `{ deferred: true }`.
   */
  async forget(id, before) {
    this.dropPending(id);
    this.servers.rememberOAuth(id, { connected: false, loginRedirect: null });
    try {
      await this.serial(before.name, () => this.clearLogin(before));
      return { deferred: false };
    } catch (error) {
      this.warn(
        `An MCP server's OAuth login could not be removed yet (${error?.code || "ERROR"}); retrying later.`,
      );
      this.servers.deferLogout(before);
      this.scheduleDrain(firstDrainMs);
      return { deferred: true };
    } finally {
      this.invalidate();
    }
  }

  /**
   * Retries logouts that failed before, one after another. It stops at the first
   * timeout or missing runtime, so a broken CLI costs one timeout, not one per
   * entry. Returns `{ remaining, freed }`: `freed` when a cleared entry matched a
   * current OAuth server, which then compiles again with the next apply.
   */
  async drain() {
    let freed = false;
    for (const target of this.servers.deferredLogouts()) {
      try {
        await this.serial(target.name, () => this.clearLogin(target));
        const definitions = this.servers.definitions();
        this.servers.settleLogout(target);
        if (definitions.some((d) => heldByLogout(d, [target]))) freed = true;
      } catch (error) {
        if (stalls.has(error?.code)) break;
      } finally {
        this.invalidate();
      }
    }
    return { remaining: this.servers.deferredLogouts().length, freed };
  }

  /**
   * Drains in the background, outside the admission lock: serialized, retried with
   * a backoff from one second to ten minutes while entries remain. A drain that
   * frees a current server calls `onFreed()` so the next apply compiles it.
   */
  scheduleDrain(delay = 0) {
    if (this.closed || this.drainTimer || this.draining) return;
    this.drainTimer = setTimeout(() => this.backgroundDrain(), delay);
    this.drainTimer.unref?.();
  }

  async backgroundDrain() {
    this.drainTimer = null;
    if (this.closed) return;
    this.draining = true;
    let result = { remaining: 1, freed: false };
    try {
      result = await this.drain();
    } catch {
      // The store may be closing; retried below unless closed.
    } finally {
      this.draining = false;
    }
    if (result.freed) {
      try {
        await this.onFreed?.();
      } catch {
        // The next apply or start compiles it.
      }
    }
    if (!result.remaining) {
      this.drainDelay = firstDrainMs;
      return;
    }
    const delay = this.drainDelay || firstDrainMs;
    this.drainDelay = Math.min(lastDrainMs, delay * 2);
    this.scheduleDrain(delay);
  }

  close() {
    this.closed = true;
    clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  /** Called with the store's previewUpdate before an update is saved. */
  async beforeUpdate(id, { before, after }) {
    if (before.auth !== "oauth") return { deferred: false };
    if (after.auth === "oauth" && before.name === after.name && before.url === after.url)
      return { deferred: false };
    return this.forget(id, before);
  }

  /** Called before server `id` is deleted. */
  async beforeRemove(id) {
    const definition = this.definition(id);
    if (definition.auth !== "oauth" || definition.transport === "stdio")
      return { deferred: false };
    return this.forget(id, definition);
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
    let deferred = [];
    let definitions = [];
    try {
      deferred = this.servers.deferredLogouts();
      if (deferred.length) definitions = this.servers.definitions();
    } catch {
      deferred = [];
    }
    return list.map((server) => {
      if (!oauth.includes(server)) return server;
      const definition = definitions.find((d) => d.id === server.id);
      if (definition && heldByLogout(definition, deferred))
        return {
          ...server,
          oauthStatus: "login-required",
          oauthReason: {
            code: "logout-pending",
            error: messages.oauthLogoutPending,
            ...messageIdentity(messages.oauthLogoutPending),
          },
        };
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
