// Brokered MCP OAuth logins of central servers in AgentPier-managed Codex accounts
// (docs/cli-mcp-qualification.md, "OAuth login brokering"). AgentPier runs
// `codex mcp login <name> --no-browser` in the account's CODEX_HOME with the file
// credential store and AgentPier's callback URL, hands the provider's callback to that
// process on stdin and lets Codex store the tokens itself. Only the pending processes
// live here (in memory, never written): no code or token ever passes through, and the
// callback URL, `code` and `state` are never logged.
import { spawn as spawnChild } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { serverMessages } from "../../lib/i18n/de.js";
import { tomlValue } from "../../lib/launch-serialization.js";
import { problem } from "../../lib/storage.js";
import { providerErrors } from "./mcp-oauth-logins.js";
import { oauthLoginUsable } from "./oauth-redirect.js";

const messages = serverMessages.mcpServers;
// Codex itself gives up after 300 s; the browser has the same five minutes.
export const codexLoginTtlMs = 5 * 60 * 1000;
const outputLimit = 64 * 1024;
const urlPattern = /https?:\/\/[^\s"'<>]+/g;

/** A refusal or failure with a stable `code` and a German catalog message. */
const failure = (message, code, status) =>
  Object.assign(problem(message, status), { code });

const keyOf = (serverId, accountId) => `${serverId}\u0000${accountId}`;

/** The authorization URL Codex printed: the first one naming a state and a redirect. */
function authorization(text) {
  for (const [candidate] of text.matchAll(urlPattern)) {
    try {
      const url = new URL(candidate);
      const state = url.searchParams.get("state");
      const redirect = url.searchParams.get("redirect_uri");
      if (state && redirect) return { url: url.href, state, redirect };
    } catch {
      // Not a URL after all; Codex prints at most one authorization URL.
    }
  }
  return null;
}

export class CodexMcpLogins {
  /**
   * - `accounts`: AccountStore (`get`, `environment`, `codexCredentialArgs`, `home`).
   * - `servers`: McpServerStore (`get`, `bindings`).
   * - `tools()`: detected CLIs; the installed Codex runs the login.
   * - `prepare(account)`: writes the central servers into the account (as a session
   *   start does), so Codex knows the server by name and URL.
   * - `inEffect()`: ids of the servers whose AgentPier entry Codex runs (after
   *   `prepare`), or null when unknown. Codex logs in by name: a server whose name the
   *   owner's own entry holds would log in that entry, so it is refused.
   * - `callbackBase()`: the callback URL Codex sends the provider to (it appends its own
   *   path segment); `remoteUrl()`: the configured HTTPS remote origin, if any.
   * - `onSettled({ serverId, name, accountId, result })`: after each completion.
   * - `onClosed({ serverId, accountId, reason })`: a login ended without a callback
   *   ("expired", "cli-failed", "replaced", "obsolete"); cancels are audited by the route.
   */
  constructor({
    accounts,
    servers,
    tools,
    prepare = async () => {},
    inEffect = () => null,
    callbackBase,
    remoteUrl = () => null,
    spawn = spawnChild,
    now = Date.now,
    schedule = (fn, ms) => setTimeout(fn, ms).unref(),
    unschedule = (timer) => clearTimeout(timer),
    onSettled = () => {},
    onClosed = () => {},
    warn = console.warn,
    ttlMs = codexLoginTtlMs,
    maxPending = 8,
    startTimeoutMs = 20000,
    completeTimeoutMs = 30000,
    killGraceMs = 2000,
  }) {
    Object.assign(this, {
      accounts,
      servers,
      tools,
      prepare,
      inEffect,
      callbackBase,
      remoteUrl,
      spawn,
      now,
      schedule,
      unschedule,
      onSettled,
      onClosed,
      warn,
      ttlMs,
      maxPending,
      startTimeoutMs,
      completeTimeoutMs,
      killGraceMs,
    });
    this.byState = new Map(); // state -> login
    this.byKey = new Map(); // server + account -> login
    this.results = new Map(); // server + account -> { result, reason? }
  }

  /** A managed Codex account; the owner's own profile keeps the CLI's own login. */
  account(accountId) {
    const account = this.accounts.get(accountId);
    if (account.kind !== "managed" || account.tool !== "codex" || account.internal)
      throw failure(messages.cliLoginAccountInvalid, "account-invalid", 409);
    return account;
  }

  /**
   * Starts a login of server `serverId` in account `accountId` from a browser on
   * `requestOrigin`. Returns `{ authorizationUrl }`. A second start for the same
   * account and server ends the first. A login counts toward the cap and can be
   * cancelled or ended from the moment it starts, before Codex printed its URL.
   */
  async start(serverId, accountId, { requestOrigin } = {}) {
    const server = this.servers.get(serverId);
    if (server.auth !== "oauth" || server.transport === "stdio")
      throw failure(messages.oauthNotOAuth, "not-oauth", 409);
    if (!this.servers.bindings("cli", "codex").includes(serverId))
      throw failure(messages.cliLoginNotBound, "not-bound", 409);
    const account = this.account(accountId);
    const usable = oauthLoginUsable({ requestOrigin, remoteUrl: this.remoteUrl() });
    if (!usable.usable)
      throw failure(
        usable.reason === "loopback-redirect"
          ? messages.oauthLoopbackRedirect
          : messages.oauthPlainHttpRemote,
        usable.reason,
        409,
      );
    const tool = this.tools().find((item) => item.id === "codex" && item.installed);
    if (!tool) throw failure(messages.cliLoginCodexMissing, "cli-missing", 409);
    const key = keyOf(serverId, accountId);
    if (!this.byKey.has(key) && this.byKey.size >= this.maxPending)
      throw failure(messages.cliLoginLimit, "login-limit", 429);
    this.replace(this.byKey.get(key));
    const login = {
      key,
      serverId,
      name: server.name,
      url: server.url,
      auth: server.auth,
      accountId,
      base: this.callbackBase(),
      child: null,
      state: null,
    };
    this.byKey.set(key, login);
    this.results.delete(key);
    // Ended (cancel, a newer start, shutdown, a removed account or server) meanwhile.
    const ended = () => this.byKey.get(key) !== login;
    try {
      await this.prepare(account);
    } catch (error) {
      this.forget(login);
      this.warn(`Codex MCP login could not prepare the account (${codeOf(error)}).`);
      throw failure(messages.cliLoginPrepareFailed, "prepare-failed", 409);
    }
    if (ended()) throw failure(messages.cliLoginEnded, "login-ended", 409);
    const effective = this.inEffect();
    if (effective && !effective.has(serverId)) {
      this.forget(login);
      throw failure(messages.cliLoginNotInEffect, "not-in-effect", 409);
    }
    try {
      await this.run(tool.path, login);
    } catch (error) {
      const gone = ended();
      this.forget(login);
      throw gone && error?.code === "cli-failed"
        ? failure(messages.cliLoginEnded, "login-ended", 409)
        : error;
    }
    if (ended()) {
      this.stop(login.child);
      throw failure(messages.cliLoginEnded, "login-ended", 409);
    }
    this.byState.set(login.state, login);
    login.expiresAt = this.now() + this.ttlMs;
    login.timer = this.schedule(() => this.expire(login), this.ttlMs);
    // Codex already gave up between printing its URL and this registration.
    if (login.exitedEarly) this.exited(login);
    return { authorizationUrl: login.authorizationUrl };
  }

  /** Spawns Codex for `login` and waits for its authorization URL. */
  run(file, login) {
    try {
      login.child = this.spawnLogin(file, login);
    } catch {
      this.warn("Codex MCP login did not start (SPAWN).");
      return Promise.reject(failure(messages.cliLoginFailed, "cli-failed", 502));
    }
    return this.watch(login);
  }

  spawnLogin(file, { name, accountId, base }) {
    return this.spawn(
      file,
      [
        ...this.accounts.codexCredentialArgs(accountId),
        "-c",
        `mcp_oauth_callback_url=${tomlValue(base)}`,
        "mcp",
        "login",
        name,
        "--no-browser",
      ],
      {
        env: this.accounts.environment(accountId),
        cwd: this.accounts.home,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }

  /** Waits for the authorization URL `login.child` prints; never logs its output. */
  watch(login) {
    const { child, base } = login;
    let output = "";
    let found = false;
    login.exit = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: null, signal: null, error: true }));
    });
    // A child that is gone makes the write fail; the exit reports it.
    child.stdin?.on("error", () => {});
    return new Promise((resolve, reject) => {
      const fail = () => {
        this.unschedule(timer);
        this.stop(child);
        reject(failure(messages.cliLoginFailed, "cli-failed", 502));
      };
      const read = (data) => {
        if (found) return;
        output = (output + String(data)).slice(-outputLimit);
        const printed = authorization(stripVTControlCharacters(output));
        if (!printed) return;
        found = true;
        output = "";
        this.unschedule(timer);
        // Codex appends a path segment of its own to the configured callback URL.
        if (!printed.redirect.startsWith(`${base}/`)) return fail();
        login.state = printed.state;
        login.authorizationUrl = printed.url;
        resolve();
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      const timer = this.schedule(() => !found && fail(), this.startTimeoutMs);
      login.exit.then(({ error }) => {
        if (found) {
          login.exitedEarly = true;
          return this.exited(login);
        }
        this.unschedule(timer);
        this.warn(`Codex MCP login did not start (${error ? "SPAWN" : "EXIT"}).`);
        reject(failure(messages.cliLoginFailed, "cli-failed", 502));
      });
    });
  }

  /** SIGTERM, then SIGKILL when the process is still there after a grace period. */
  stop(child) {
    if (!child) return;
    child.kill("SIGTERM");
    const timer = this.schedule(() => {
      if (child.exitCode === null && child.signalCode == null) child.kill("SIGKILL");
    }, this.killGraceMs);
    child.once?.("exit", () => this.unschedule(timer));
  }

  /** Forgets `login` without a result and ends its process. */
  end(login) {
    if (!login) return;
    this.forget(login);
    this.stop(login.child);
  }

  /** A newer start for the same pair ends `login`; audited as a failure. */
  replace(login) {
    if (!login) return;
    this.end(login);
    this.closed(login, "replaced");
  }

  forget(login) {
    if (login.state && this.byState.get(login.state) === login)
      this.byState.delete(login.state);
    if (this.byKey.get(login.key) === login) this.byKey.delete(login.key);
    this.unschedule(login.timer);
  }

  record(login, result, reason) {
    this.results.set(login.key, reason ? { result, reason } : { result });
  }

  /** Reports a login that ended without a callback (`onClosed`, for the audit). */
  closed(login, reason) {
    try {
      this.onClosed({ serverId: login.serverId, accountId: login.accountId, reason });
    } catch {
      // The audit trail must not keep a login alive.
    }
  }

  expire(login) {
    if (this.byKey.get(login.key) !== login) return;
    this.forget(login);
    this.record(login, "error", "expired");
    this.stop(login.child);
    this.closed(login, "expired");
  }

  /** Codex ended while it still waited for its callback (its own timeout, a crash). */
  exited(login) {
    if (!login.state || this.byState.get(login.state) !== login) return;
    this.forget(login);
    this.record(login, "error", "cli-failed");
    this.closed(login, "cli-failed");
  }

  /**
   * Ends every login whose account is gone or whose server is gone, renamed, moved to
   * another URL or auth method, or no longer bound to Codex (called after such
   * changes). Results of those pairs go too.
   */
  prune() {
    let bound;
    try {
      bound = new Set(this.servers.bindings("cli", "codex"));
    } catch {
      return;
    }
    const current = (serverId, accountId, login) => {
      try {
        this.account(accountId);
        const server = this.servers.get(serverId);
        return (
          bound.has(serverId) &&
          (login === undefined ||
            (server.name === login.name &&
              server.url === login.url &&
              server.auth === login.auth))
        );
      } catch {
        return false;
      }
    };
    for (const login of [...this.byKey.values()])
      if (!current(login.serverId, login.accountId, login)) {
        this.end(login);
        this.results.delete(login.key);
        this.closed(login, "obsolete");
      }
    for (const key of [...this.results.keys()]) {
      const [serverId, accountId] = key.split("\u0000");
      if (!current(serverId, accountId)) this.results.delete(key);
    }
  }

  /**
   * Completes the login whose `state` the callback `requestPath` (path and query, as
   * received) carries: the full callback URL, rebuilt from the base the login was
   * started with, goes to the waiting Codex as one line. Returns `{ serverId,
   * accountId, result: "connected" }`, `{ …, result: "error", reason }`, or
   * `{ result: "error", reason: "state-invalid" }` for a state that is unknown,
   * expired, used or replaced (nothing runs then).
   */
  async complete(requestPath) {
    const url = new URL(requestPath, "http://callback.invalid");
    const states = url.searchParams.getAll("state");
    const login = states.length === 1 ? this.byState.get(states[0]) : undefined;
    if (!login) return { result: "error", reason: "state-invalid" };
    // Single use: consumed synchronously, before anything awaits.
    this.forget(login);
    if (this.now() >= login.expiresAt) {
      this.record(login, "error", "expired");
      this.stop(login.child);
      this.closed(login, "expired");
      return { result: "error", reason: "state-invalid" };
    }
    login.child.stdin.write(`${new URL(url.pathname + url.search, login.base).href}\n`);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.schedule(() => resolve(null), this.completeTimeoutMs);
    });
    const exit = await Promise.race([login.exit, timeout]);
    this.unschedule(timer);
    const error = url.searchParams.get("error");
    let reason = null;
    if (!exit) {
      this.stop(login.child);
      reason = "cli-timeout";
    } else if (exit.code !== 0)
      reason = error
        ? providerErrors.has(error)
          ? error
          : "provider-error"
        : "cli-failed";
    const result = reason ? "error" : "connected";
    this.record(login, result, reason);
    if (reason && !providerErrors.has(reason))
      this.warn(`Codex MCP login could not be completed (${reason}).`);
    const done = { serverId: login.serverId, accountId: login.accountId, result };
    try {
      await this.onSettled({ ...done, name: login.name });
    } catch {
      // A status refresh must not undo a completed login.
    }
    return reason ? { ...done, reason } : done;
  }

  /** Ends the pending login of `accountId` for `serverId`; false when there is none. */
  cancel(serverId, accountId) {
    const key = keyOf(serverId, accountId);
    const login = this.byKey.get(key);
    this.results.delete(key);
    if (!login) return false;
    this.end(login);
    return true;
  }

  /** `{ [accountId]: { pending: true } | { result, reason? } }` for server `serverId`. */
  view(serverId) {
    const out = {};
    for (const [key, result] of this.results) {
      const [server, account] = key.split("\u0000");
      if (server === serverId) out[account] = result;
    }
    for (const login of this.byKey.values())
      if (login.serverId === serverId) out[login.accountId] = { pending: true };
    return out;
  }

  /** Ends every pending login (AgentPier shuts down). */
  close() {
    for (const login of [...this.byKey.values()]) this.end(login);
  }
}

// Only a stable error code is logged, never a message, path or value.
const codeOf = (error) =>
  typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code
    : "ERROR";
