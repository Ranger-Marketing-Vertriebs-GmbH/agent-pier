// Drives `openclaw mcp login|status|logout` against the Gateway's private state (see
// docs/mcp-oauth-qualification.md). The CLI needs the Gateway's HOME,
// OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH (plus PATH), neither its token nor a
// running Gateway. Nothing here logs; thrown messages are redacted.
import { execFile as nodeExecFile } from "node:child_process";
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
  // OpenClaw's own test for a registration refused over the redirect URL.
  [/invalid_client_metadata|redirect_uri/i, "redirect-rejected"],
  [/Missing MCP OAuth authorization session/i, "session-missing"],
  [/No MCP server named/i, "server-unknown"],
];

function reasonOf(stderr) {
  const lines = String(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const reason = lines.find((line) => /^Reason:/i.test(line)) || lines.at(-1) || "";
  return reason.replace(/^(Error|Reason):\s*/i, "");
}

function failure(command, error, stderr, secrets) {
  if (error.killed && error.signal && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return new McpCliError("cli-timeout", `OpenClaw MCP ${command} timed out.`);
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return new McpCliError(
      "cli-failed",
      `OpenClaw MCP ${command} printed too much output.`,
    );
  if (typeof error.code !== "number")
    return new McpCliError("cli-failed", `OpenClaw MCP ${command} could not run.`);
  const code = known.find(([pattern]) => pattern.test(stderr))?.[1] || "cli-failed";
  const reason = redact(reasonOf(stderr), secrets).slice(0, reasonLength);
  return new McpCliError(
    code,
    `OpenClaw MCP ${command} failed (exit ${error.code})${reason ? `: ${reason}` : "."}`,
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

/** The authorization URL and its `state` from the output of `openclaw mcp login`. */
export function parseLoginOutput(stdout, name) {
  const all = lines(stdout);
  const saved = `MCP OAuth credentials saved for "${name}".`;
  const prompt = all.findIndex((line) => line.startsWith("Open this URL to authorize"));
  if (prompt < 0) {
    if (all.includes(saved)) return { authorized: true };
    return null;
  }
  let url;
  try {
    url = new URL(all[prompt + 1] || "");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
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
  // A revoked refresh token leaves pending-authorization without tokens.
  if (state === "pending-authorization") return "login-required";
  if (state === "unauthenticated" && (everConnected || authStatus.hasClientInformation))
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
  execFile = nodeExecFile,
}) {
  function run(command, args, secrets = []) {
    const current = resolve(runtime);
    if (!current?.nodePath || !current?.entryPath)
      return Promise.reject(
        new McpCliError("runtime-unavailable", "The assistant runtime is not available."),
      );
    const env = { ...resolve(environment) };
    delete env.OPENCLAW_GATEWAY_TOKEN;
    return new Promise((done, fail) => {
      execFile(
        current.nodePath,
        [current.entryPath, "mcp", ...args],
        {
          env,
          cwd: current.cwd,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: maxOutputBytes,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) fail(failure(command, error, stderr || "", secrets));
          else done(String(stdout));
        },
      );
    });
  }

  return {
    async startLogin(name) {
      checkedName(name);
      const stdout = await run("login", ["login", name]);
      const parsed = parseLoginOutput(stdout, name);
      if (!parsed)
        throw new McpCliError(
          "url-missing",
          "OpenClaw MCP login printed no authorization URL.",
        );
      return parsed;
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
    async logout(name) {
      checkedName(name);
      const stdout = await run("logout", ["logout", name]);
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

/** The Gateway's private environment for the CLI, without the Gateway token. */
export function cliEnvironment(paths, nodePath, parent = process.env) {
  const env = runtimeEnvironment(paths, nodePath, undefined, parent);
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
