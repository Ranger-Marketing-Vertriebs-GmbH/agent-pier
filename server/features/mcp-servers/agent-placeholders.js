import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

/**
 * Agent placeholders in a local (stdio) server's settings (docs/mcp.md#agent-placeholders):
 * `{agent.workspace}` and `{agent.attachments}` stand for the bound agent's own
 * folders. AgentPier resolves them per agent when it compiles the agents' servers;
 * they are never free-form expressions. A value holds at most one placeholder, as the
 * whole value or followed by a subfolder (`{agent.workspace}/voice`); an argument may
 * also start with fixed text (`--dir={agent.workspace}`). Neither `.` nor `..` nor an
 * empty segment may follow, so a resolved path never leaves the agent's workspace.
 */
export const placeholderNames = ["agent.workspace", "agent.attachments"];
export const PLACEHOLDER = "MCP_SERVER_PLACEHOLDER";

// The namespaces AgentPier reserves: any `{agent.…}` or `{session.…}` must be valid.
const candidate = /\{\s*(?:agent|session)\s*\./i;
const shape = /^([^{}]*)\{([^{}]*)\}([^{}]*)$/;
const badSegment = /[\x00-\x1f\x7f]/;
// The workspace root holds one folder per agent id (agent-attachments.js).
const agentId = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

/** Whether `value` is a string that uses (or mistypes) an agent placeholder. */
export const hasPlaceholderCandidate = (value) =>
  typeof value === "string" && candidate.test(value);

/**
 * `{ prefix, name, segments }` for a valid placeholder value, `null` for a value
 * without any candidate, `false` for one that uses the namespace wrongly. `prefix`
 * allows fixed text before the placeholder (arguments only).
 */
export function parsePlaceholder(value, { prefix: allowPrefix = false } = {}) {
  if (!hasPlaceholderCandidate(value)) return null;
  const match = shape.exec(value);
  if (!match) return false;
  const [, prefix, name, tail] = match;
  if (!placeholderNames.includes(name) || (prefix && !allowPrefix)) return false;
  if (tail === "" || tail === "/") return { prefix, name, segments: [] };
  if (!tail.startsWith("/")) return false;
  const segments = tail.slice(1).replace(/\/$/, "").split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" || segment === "." || segment === ".." || badSegment.test(segment),
    )
  )
    return false;
  return { prefix, name, segments };
}

/**
 * The agent's own folders by placeholder name, or null when `assistantId` could name
 * anything but one folder directly below the absolute workspace root.
 */
export function agentFolders(workspaces, assistantId) {
  if (typeof workspaces !== "string" || !path.isAbsolute(workspaces)) return null;
  if (typeof assistantId !== "string" || !agentId.test(assistantId)) return null;
  const workspace = path.join(workspaces, assistantId);
  return {
    "agent.workspace": workspace,
    "agent.attachments": path.join(workspace, "attachments"),
  };
}

/**
 * `{ value, path }` with the placeholder replaced by the agent's folder, `null` for a
 * value without a placeholder, `false` for an invalid one.
 */
export function resolvePlaceholder(value, folders, prefix = false) {
  const parsed = parsePlaceholder(value, { prefix });
  if (!parsed) return parsed;
  const resolved = path.join(folders[parsed.name], ...parsed.segments);
  return { value: parsed.prefix + resolved, path: resolved };
}

const stdio = (server) => server?.transport === "stdio";
const envEntries = (env) =>
  env && typeof env === "object" ? Object.entries(env).filter(([, v]) => v != null) : [];

/** Whether a stdio definition (with its environment values) uses a placeholder. */
export function usesAgentPlaceholders(server, env = {}) {
  if (!stdio(server)) return false;
  return (
    (Array.isArray(server.args) && server.args.some(hasPlaceholderCandidate)) ||
    hasPlaceholderCandidate(server.cwd) ||
    envEntries(env).some(([, value]) => hasPlaceholderCandidate(value))
  );
}

/**
 * Where a stdio server uses placeholders, as the owner wrote them: argument indexes,
 * the working directory and environment names. Only valid placeholder values are
 * shown; an environment value is then a path below the agent's folder, never a secret.
 */
export function placeholderTemplates(server, env = {}) {
  const out = { args: [], cwd: null, env: {} };
  if (!stdio(server)) return out;
  (server.args || []).forEach((template, index) => {
    if (parsePlaceholder(template, { prefix: true })) out.args.push({ index, template });
  });
  if (parsePlaceholder(server.cwd)) out.cwd = server.cwd;
  for (const [name, value] of envEntries(env))
    if (parsePlaceholder(value)) out.env[name] = value;
  return out;
}

/**
 * `{ agentPlaceholders: true, placeholders }` for a stored row (`args` as stored
 * JSON) that uses agent placeholders, with where (placeholderTemplates); else `{}`.
 */
export function rowPlaceholders(row, env = {}) {
  if (row?.transport !== "stdio") return {};
  let args = [];
  try {
    args = JSON.parse(row.args);
  } catch {
    // An unreadable row uses none; the compiler skips it anyway.
  }
  const server = { transport: "stdio", args, cwd: row.cwd };
  if (!usesAgentPlaceholders(server, env)) return {};
  return { agentPlaceholders: true, placeholders: placeholderTemplates(server, env) };
}

/**
 * The definition and environment with every placeholder resolved for one agent, and
 * the resolved `paths` (for the caller's folder checks); null when any stored value
 * uses the namespace wrongly, so nothing half-resolved ever runs.
 */
export function resolveStdioServer(server, env, folders) {
  const paths = [];
  const one = (value, prefix = false) => {
    const resolved = resolvePlaceholder(value, folders, prefix);
    if (resolved === null) return value;
    if (resolved === false) throw new Error("placeholder");
    paths.push(resolved.path);
    return resolved.value;
  };
  try {
    const args = Array.isArray(server.args)
      ? server.args.map((arg) => one(arg, true))
      : server.args;
    const cwd = typeof server.cwd === "string" ? one(server.cwd) : server.cwd;
    const resolvedEnv = Object.fromEntries(
      Object.entries(env || {}).map(([name, value]) => [name, one(value)]),
    );
    return { server: { ...server, args, cwd }, env: resolvedEnv, paths };
  } catch {
    return null;
  }
}

function refuse(field, names = []) {
  throw Object.assign(problem(serverMessages.mcpServers.placeholderInvalid, 400), {
    code: PLACEHOLDER,
    field,
    names,
  });
}

/**
 * Refuses (400 MCP_SERVER_PLACEHOLDER) an input that uses the placeholder namespace
 * wrongly: an unknown or malformed placeholder, or one outside a stdio server's
 * arguments, working directory and environment. Only the fields present are checked.
 * The error names the `field` and, for headers and environment, the `names`.
 */
export function requireValidPlaceholders(input, transport = input?.transport) {
  if (!input || typeof input !== "object") return;
  const local = transport === "stdio";
  for (const field of ["url", "command"])
    if (hasPlaceholderCandidate(input[field])) refuse(field);
  if (Array.isArray(input.args) && input.args.some(hasPlaceholderCandidate))
    if (
      !local ||
      input.args.some((arg) => parsePlaceholder(arg, { prefix: true }) === false)
    )
      refuse("args");
  if (
    hasPlaceholderCandidate(input.cwd) &&
    (!local || parsePlaceholder(input.cwd) === false)
  )
    refuse("cwd");
  for (const field of ["headers", "env"]) {
    const map = input[field];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    const allowed = local && field === "env";
    const names = Object.keys(map).filter(
      (name) =>
        hasPlaceholderCandidate(map[name]) &&
        (!allowed || parsePlaceholder(map[name]) === false),
    );
    if (names.length) refuse(field, names);
  }
}
