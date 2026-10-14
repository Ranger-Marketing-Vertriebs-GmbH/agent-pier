// Drives `openclaw mcp login|status|logout` against the Gateway's private state (see
// docs/mcp-oauth-qualification.md). The CLI needs the Gateway's HOME,
// OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH (plus PATH), neither its token nor a
// running Gateway. Nothing here logs; thrown messages are redacted.
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runtimeEnvironment } from "../assistants/runtime-config.js";
import { namePattern } from "./command-resolution.js";

export const mcpCliErrorCodes = Object.freeze([
  "runtime-unavailable",
  "invalid-name",
  "invalid-code",
  "cli-timeout",
  "cli-failed",
  "url-missing",
  "no-dynamic-registration",
  "redirect-rejected",
  "session-missing",
  "server-unknown",
]);

export class McpCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "McpCliError";
    this.code = code;
  }
}

// A login with the redirect port taken exits in about a second; one that could bind
// the port would wait 300 s for a callback, so the budget stays short.
const defaultTimeoutMs = 20000;
const defaultMaxOutputBytes = 256 * 1024;
const reasonLength = 300;
// OpenClaw takes its MCP OAuth lease in SQLite write transactions that do not wait
// for a lock: while the Gateway (or another CLI) writes the shared state database, a
// login or logout fails at once. Only a failure to start the lease's own transaction
// is repeated: "store unavailable (sqlite-busy)", or "database is locked" from
// `operation=state.lease ... step=begin`. Before the lease nothing has happened (a
// `--code` keeps its code unused). The same signature can come from the release after a
// completed `--code`: the dead CLI then still holds the lease, so the repeat usually
// waits into a timeout (otherwise it finds no authorization session); it never
// exchanges again and the tokens stay, which McpOAuthLogins.complete() checks. A lock
// anywhere else may follow the code exchange: repeating `--code` with the used code
// would make OpenClaw's SDK drop the tokens it just saved, so that failure stands.
export const defaultBusyRetryDelaysMs = [250, 1000];
const leaseLockLine = /\boperation=state\.lease\b.*\bstep=begin\b/;
// One login and up to two repeats after a redacted authorization URL (see
// parseLoginOutput): all three are hit by chance about once in eight million.
const defaultLoginAttempts = 3;

/** Whether the CLI failed only because its lease transaction could not start. */
export function leaseLocked(stderr) {
  const reason = reasonOf(stderr);
  if (/store unavailable \(sqlite-busy\)/i.test(reason)) return true;
  return /^database is locked$/i.test(reason) && leaseLockLine.test(stderr);
}

const tokenParameters =
  /\b(code|state|token|access_token|refresh_token|id_token|client_secret|code_verifier|code_challenge)=([^&\s"'<>]+)/gi;

/**
 * Removes `secrets` (and their URL-encoded forms), credentials in URLs, bearer
 * values, JWTs and long opaque runs from `text`.
 */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || !secret) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)]))
      out = out.split(form).join("[redacted]");
  }
  return out
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => url.replace(/[?#].*$/, "?[redacted]"))
    .replace(tokenParameters, "$1=[redacted]")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, "[redacted]")
    .replace(/[A-Za-z0-9_\-+=.~]{24,}/g, "[redacted]");
}

const known = [
  [/does not support dynamic client registration/i, "no-dynamic-registration"],
  // A registration or authorization refused over the redirect URL (OpenClaw's own
  // test uses invalid_client_metadata). A bare "redirect_uri" in a printed URL or an
  // unrelated message does not count.
  [
    /\binvalid_client_metadata\b|\binvalid_redirect_uri\b|\bredirect[_ ]ur[il]\b[^\n]{0,80}\b(?:invalid|not allowed|not registered|mismatch(?:ed)?|rejected)\b|\b(?:invalid|unregistered|mismatch(?:ed)?)\b[^\n]{0,40}\bredirect[_ ]ur[il]\b/i,
    "redirect-rejected",
  ],
  [/Missing MCP OAuth authorization session/i, "session-missing"],
  [/No MCP server named/i, "server-unknown"],
];

function reasonOf(stderr) {
  const lines = String(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  // OpenClaw prints "[openclaw] Reason: ..." between other "[openclaw]" lines.
  const reason =
    lines.find((line) => /^(\[openclaw\]\s*)?Reason:/i.test(line)) || lines.at(-1) || "";
  return reason.replace(/^(\[openclaw\]\s*)?(Error|Reason):\s*/i, "");
}

function failure(command, exitCode, stderr, secrets) {
  if (!Number.isInteger(exitCode))
    return new McpCliError("cli-failed", `OpenClaw MCP ${command} could not run.`);
  const code = known.find(([pattern]) => pattern.test(stderr))?.[1] || "cli-failed";
  const reason = redact(reasonOf(stderr), secrets).slice(0, reasonLength);
  return new McpCliError(
    code,
    `OpenClaw MCP ${command} failed (exit ${exitCode})${reason ? `: ${reason}` : "."}`,
  );
}

const checkedName = (name) => {
  if (typeof name !== "string" || !namePattern.test(name))
    throw new McpCliError("invalid-name", "Invalid MCP server name.");
  return name;
};

const resolve = (value) => (typeof value === "function" ? value() : value);

const lines = (text) =>
  String(text)
    .split(/\r?\n/)
    .map((line) => line.trim());

// OpenClaw 2026.9.8 passes every console line through its secret redaction, which
// masks values that merely look like keys: `uH-5fn…uU68` (six characters, an
// ellipsis, the last four) or `…***`. About one random PKCE challenge in 200 in a
// printed authorization URL is hit (494 of 100,000 sampled). The provider then
// stores the masked challenge, and `--code` fails with InvalidGrantError because the
// verifier no longer matches. A serialized URL never contains anything outside
// printable ASCII, nor `***`, and an S256 challenge is exactly 43 base64url
// characters (RFC 7636), so such a URL is recognized and never handed out.
const s256Challenge = /^[A-Za-z0-9_-]{43}$/;

function redactedUrl(line, url) {
  if (/[^\x21-\x7e]|\*\*\*/.test(line)) return true;
  const query = url.searchParams;
  return (
    query.get("code_challenge_method") === "S256" &&
    !s256Challenge.test(query.get("code_challenge") ?? "")
  );
}

/**
 * The authorization URL and its `state` from the output of `openclaw mcp login`:
 * `{ authorizationUrl, state }`, `{ authorized: true }` after a mere refresh,
 * `{ redacted: true }` for a URL OpenClaw's output redaction mangled, or null.
 */
export function parseLoginOutput(stdout, name) {
  const all = lines(stdout);
  const saved = `MCP OAuth credentials saved for "${name}".`;
  const prompt = all.findIndex((line) => line.startsWith("Open this URL to authorize"));
  if (prompt < 0) {
    if (all.includes(saved)) return { authorized: true };
    return null;
  }
  const line = all[prompt + 1] || "";
  let url;
  try {
    url = new URL(line);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (redactedUrl(line, url)) return { redacted: true };
  const state = url.searchParams.get("state");
  if (!state) return null;
  return { authorizationUrl: url.href, state };
}

const authStates = new Set([
  "unauthenticated",
  "pending-authorization",
  "authorized",
  "requires-authorization",
]);

/** `{ [name]: { state, expiresAt?, hasTokens, ... } }` for OAuth servers in status JSON. */
export function parseStatusOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.servers)) return null;
  const result = {};
  for (const server of parsed.servers) {
    if (!server || server.auth !== "oauth" || typeof server.name !== "string") continue;
    const auth = server.authStatus || {};
    const entry = {
      state: authStates.has(auth.state) ? auth.state : "unknown",
      hasTokens: auth.hasTokens === true,
      requiresAuthorization: auth.requiresAuthorization === true,
      hasClientInformation: auth.hasClientInformation === true,
    };
    if (Number.isFinite(auth.expiresAt)) entry.expiresAt = auth.expiresAt;
    result[server.name] = entry;
  }
  return result;
}

/**
 * The AgentPier status of an OAuth server: "connected", "login-pending",
 * "login-required" or "not-connected". `pendingLogin` is true while AgentPier holds
 * an unexpired login for it; `everConnected` marks a server that was logged in
 * before (an unauthenticated one then needs a new login rather than a first one).
 */
export function oauthStatus(
  authStatus,
  { pendingLogin = false, everConnected = false } = {},
) {
  const state = authStatus?.state;
  if (state === "authorized") return "connected";
  if (pendingLogin) return "login-pending";
  if (state === "requires-authorization") return "login-required";
  // A revoked refresh token leaves pending-authorization without tokens, but with the
  // registered client. An agent turn that tried a server never logged in leaves
  // pending-authorization without a client: that server is still not connected.
  if (
    (state === "pending-authorization" || state === "unauthenticated") &&
    (everConnected || authStatus.hasClientInformation)
  )
    return "login-required";
  return "not-connected";
}

/**
 * A wrapper around the OpenClaw MCP CLI. `runtime` ({ nodePath, entryPath, cwd? })
 * and `environment` may be functions resolved per call; a missing runtime fails
 * with `runtime-unavailable`.
 */
export function createMcpCli({
  runtime,
  environment,
  timeoutMs = defaultTimeoutMs,
  maxOutputBytes = defaultMaxOutputBytes,
  busyRetryDelaysMs = defaultBusyRetryDelaysMs,
  loginAttempts = defaultLoginAttempts,
  spawn = nodeSpawn,
}) {
  async function run(command, args, secrets = [], overrides = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await runOnce(command, args, secrets, overrides);
      } catch (error) {
        if (!error.busy || attempt >= busyRetryDelaysMs.length) throw error;
        await new Promise((resume) => setTimeout(resume, busyRetryDelaysMs[attempt]));
      }
    }
  }

  function runOnce(command, args, secrets, overrides) {
    const current = resolve(runtime);
    if (!current?.nodePath || !current?.entryPath)
      return Promise.reject(
        new McpCliError("runtime-unavailable", "The assistant runtime is not available."),
      );
    // OpenClaw 2026.10 prints a failed command's "Reason:" line (which failure() and
    // leaseLocked() read) only with OPENCLAW_DEBUG; it changes nothing else there.
    const env = { ...resolve(environment), OPENCLAW_DEBUG: "1", ...overrides };
    delete env.OPENCLAW_GATEWAY_TOKEN;
    return new Promise((done, reject) => {
      // Its own process group, so a timeout or an output flood also ends what the
      // CLI spawned, and nothing outside that group. (execFile cannot detach.)
      const child = spawn(current.nodePath, [current.entryPath, "mcp", ...args], {
        env,
        cwd: current.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const output = { stdout: [], stderr: [], bytes: 0 };
      let reason = null;
      const stop = (why) => {
        if (reason) return;
        reason = why;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      for (const stream of ["stdout", "stderr"])
        child[stream].on("data", (chunk) => {
          output.bytes += chunk.length;
          if (output.bytes > maxOutputBytes) return stop("flood");
          output[stream].push(chunk);
        });
      const text = (stream) => Buffer.concat(output[stream]).toString("utf8");
      child.once("error", () => {
        clearTimeout(timer);
        reject(new McpCliError("cli-failed", `OpenClaw MCP ${command} could not run.`));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (reason === "timeout")
          return reject(
            new McpCliError("cli-timeout", `OpenClaw MCP ${command} timed out.`),
          );
        if (reason === "flood")
          return reject(
            new McpCliError(
              "cli-failed",
              `OpenClaw MCP ${command} printed too much output.`,
            ),
          );
        if (code === 0) return done(text("stdout"));
        const stderr = text("stderr");
        reject(
          Object.assign(failure(command, code, stderr, secrets), {
            busy: leaseLocked(stderr),
          }),
        );
      });
    });
  }

  return {
    async startLogin(name) {
      checkedName(name);
      // A redacted URL is useless: a new `login` replaces the session with a fresh
      // verifier, challenge and state. Only a redaction that sticks (a provider's
      // client id that looks like a key) exhausts the attempts.
      for (let attempt = 1; ; attempt++) {
        const parsed = parseLoginOutput(await run("login", ["login", name]), name);
        if (parsed?.redacted && attempt < loginAttempts) continue;
        if (!parsed || parsed.redacted)
          throw new McpCliError(
            "url-missing",
            parsed
              ? "OpenClaw MCP login printed only a redacted authorization URL."
              : "OpenClaw MCP login printed no authorization URL.",
          );
        return parsed;
      }
    },
    async completeLogin(name, code) {
      checkedName(name);
      if (
        typeof code !== "string" ||
        !code ||
        code.length > 4096 ||
        /[\s\p{Cc}]/u.test(code)
      )
        throw new McpCliError("invalid-code", "Invalid OAuth authorization code.");
      // `--code=<code>` keeps a code that starts with "-" from reading as an option.
      const stdout = await run("login", ["login", name, `--code=${code}`], [code]);
      if (!lines(stdout).includes(`MCP OAuth credentials saved for "${name}".`))
        throw new McpCliError(
          "cli-failed",
          "OpenClaw MCP login did not save credentials.",
        );
    },
    /**
     * Clears the login of `name`. With `server` (its compiled `mcp.servers` entry) the
     * CLI reads a private one-server config instead of the Gateway's, so a login can
     * be cleared under a name and URL the Gateway no longer compiles: OpenClaw keys
     * logins by name and URL only (docs/mcp-oauth-qualification.md (e)).
     */
    async logout(name, { server } = {}) {
      checkedName(name);
      let stdout;
      if (server) {
        // Inside the Gateway's private state directory, next to the tokens it
        // clears: a 0700 directory with a 0600 file, swept at startup if a kill left
        // it behind (sweepLogoutConfigs).
        const current = resolve(runtime);
        const stateDir =
          current?.nodePath && current?.entryPath
            ? resolve(environment)?.OPENCLAW_STATE_DIR
            : null;
        if (!stateDir || !path.isAbsolute(stateDir))
          throw new McpCliError(
            "runtime-unavailable",
            "The assistant runtime is not available.",
          );
        fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const dir = fs.mkdtempSync(path.join(stateDir, logoutPrefix));
        fs.chmodSync(dir, 0o700);
        const config = path.join(dir, "openclaw.json");
        try {
          fs.writeFileSync(
            config,
            JSON.stringify({ mcp: { servers: { [name]: server } } }),
            {
              mode: 0o600,
            },
          );
          stdout = await run("logout", ["logout", name], [], {
            OPENCLAW_CONFIG_PATH: config,
          });
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } else stdout = await run("logout", ["logout", name]);
      if (!lines(stdout).includes(`MCP OAuth credentials cleared for "${name}".`))
        throw new McpCliError(
          "cli-failed",
          "OpenClaw MCP logout did not clear credentials.",
        );
    },
    async status() {
      const parsed = parseStatusOutput(await run("status", ["status", "--json"]));
      if (!parsed)
        throw new McpCliError("cli-failed", "OpenClaw MCP status printed no valid JSON.");
      return parsed;
    },
  };
}

const logoutPrefix = "agentpier-mcp-logout-";

/** Removes one-server logout configs a killed process left in `stateDir`. */
export function sweepLogoutConfigs(stateDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries)
    if (entry.isDirectory() && entry.name.startsWith(logoutPrefix)) {
      fs.rmSync(path.join(stateDir, entry.name), { recursive: true, force: true });
      removed++;
    }
  return removed;
}

/** The Gateway's private environment for the CLI, without the Gateway token. */
export function cliEnvironment(paths, nodePath, parent = process.env) {
  const env = runtimeEnvironment(paths, nodePath, parent);
  delete env.OPENCLAW_GATEWAY_TOKEN;
  return env;
}

/** A wrapper bound to the runtime the supervisor last launched, resolved per call. */
export function supervisorMcpCli(supervisor, options = {}) {
  const current = () => supervisor.runtime;
  return createMcpCli({
    ...options,
    runtime: () =>
      current()
        ? {
            nodePath: current().nodePath,
            entryPath: current().entryPath,
            cwd: supervisor.paths.root,
          }
        : null,
    environment: () => cliEnvironment(supervisor.paths, current().nodePath),
  });
}
