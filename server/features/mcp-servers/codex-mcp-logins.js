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
   * - `callbackBase()`: the callback URL Codex sends the provider to (it appends its own
   *   path segment); `remoteUrl()`: the configured HTTPS remote origin, if any.
   * - `onSettled({ serverId, name, accountId, result })`: after each completion.
   */
  constructor({
    accounts,
    servers,
    tools,
    prepare = async () => {},
    callbackBase,
    remoteUrl = () => null,
    spawn = spawnChild,
    now = Date.now,
    schedule = (fn, ms) => setTimeout(fn, ms).unref(),
    unschedule = (timer) => clearTimeout(timer),
    onSettled = () => {},
    warn = console.warn,
    ttlMs = codexLoginTtlMs,
    maxPending = 8,
    startTimeoutMs = 20000,
    completeTimeoutMs = 30000,
  }) {
    Object.assign(this, {
      accounts,
      servers,
      tools,
      prepare,
      callbackBase,
      remoteUrl,
      spawn,
      now,
      schedule,
      unschedule,
      onSettled,
      warn,
      ttlMs,
      maxPending,
      startTimeoutMs,
      completeTimeoutMs,
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
   * account and server ends the first.
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
    this.end(this.byKey.get(key));
    try {
      await this.prepare(account);
    } catch (error) {
      this.warn(`Codex MCP login could not prepare the account (${codeOf(error)}).`);
      throw failure(messages.cliLoginPrepareFailed, "prepare-failed", 409);
    }
    const base = this.callbackBase();
    const login = await this.run(tool.path, server, accountId, base);
    // A start that raced this one for the same pair loses.
    this.end(this.byKey.get(key));
    this.results.delete(key);
    this.byState.set(login.state, login);
    this.byKey.set(key, login);
    login.timer = this.schedule(() => this.expire(login), this.ttlMs);
    return { authorizationUrl: login.authorizationUrl };
  }

  /** Spawns Codex and waits for its authorization URL. */
  run(file, server, accountId, base) {
    let child;
    try {
      child = this.spawnLogin(file, server, accountId, base);
    } catch {
      this.warn("Codex MCP login did not start (SPAWN).");
      return Promise.reject(failure(messages.cliLoginFailed, "cli-failed", 502));
    }
    return this.watch(child, server, accountId, base);
  }

  spawnLogin(file, server, accountId, base) {
    return this.spawn(
      file,
      [
        ...this.accounts.codexCredentialArgs(accountId),
        "-c",
        `mcp_oauth_callback_url=${tomlValue(base)}`,
        "mcp",
        "login",
        server.name,
        "--no-browser",
      ],
      {
        env: this.accounts.environment(accountId),
        cwd: this.accounts.home,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }

  /** Waits for the authorization URL `child` prints; never logs its output. */
  watch(child, server, accountId, base) {
    let output = "";
    let found = null;
    const exit = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: null, signal: null, error: true }));
    });
    // A child that is gone makes the write fail; the exit reports it.
    child.stdin?.on("error", () => {});
    return new Promise((resolve, reject) => {
      const fail = () => {
        this.unschedule(timer);
        child.kill("SIGTERM");
        reject(failure(messages.cliLoginFailed, "cli-failed", 502));
      };
      const read = (data) => {
        if (found) return;
        output = (output + String(data)).slice(-outputLimit);
        const printed = authorization(stripVTControlCharacters(output));
        if (!printed) return;
        found = printed;
        output = "";
        this.unschedule(timer);
        // Codex appends a path segment of its own to the configured callback URL.
        if (!printed.redirect.startsWith(`${base}/`)) return fail();
        resolve({
          serverId: server.id,
          name: server.name,
          accountId,
          key: keyOf(server.id, accountId),
          state: printed.state,
          authorizationUrl: printed.url,
          base,
          child,
          exit,
          expiresAt: this.now() + this.ttlMs,
        });
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      const timer = this.schedule(() => !found && fail(), this.startTimeoutMs);
      exit.then(({ error }) => {
        if (found) return this.exited(found.state);
        this.unschedule(timer);
        this.warn(`Codex MCP login did not start (${error ? "SPAWN" : "EXIT"}).`);
        reject(failure(messages.cliLoginFailed, "cli-failed", 502));
      });
    });
  }

  /** Forgets `login` without a result and ends its process. */
  end(login) {
    if (!login) return;
    this.forget(login);
    login.child.kill("SIGTERM");
  }

  forget(login) {
    if (this.byState.get(login.state) === login) this.byState.delete(login.state);
    if (this.byKey.get(login.key) === login) this.byKey.delete(login.key);
    this.unschedule(login.timer);
  }

  record(login, result, reason) {
    this.results.set(login.key, reason ? { result, reason } : { result });
  }

  expire(login) {
    if (this.byKey.get(login.key) !== login) return;
    this.forget(login);
    this.record(login, "error", "expired");
    login.child.kill("SIGTERM");
  }

  /** Codex ended while it still waited for its callback (its own timeout, a crash). */
  exited(state) {
    const login = this.byState.get(state);
    if (!login) return;
    this.forget(login);
    this.record(login, "error", "cli-failed");
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
      login.child.kill("SIGTERM");
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
      login.child.kill("SIGTERM");
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
