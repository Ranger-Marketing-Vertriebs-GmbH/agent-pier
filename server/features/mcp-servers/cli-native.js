import { createHash } from "node:crypto";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { mcpUrl, nativeMcp, record, values } from "../extensions/mcp-config.js";
import { namePattern } from "./command-resolution.js";
import { nativeTimeoutKeys, nativeTimeouts, timeoutsFromNative } from "./mcp-timeouts.js";
import { hasReference, referenceNames } from "./value-references.js";
import { usesAgentPlaceholders } from "./agent-placeholders.js";

/** The coding CLIs a central server can be bound to: the `cli` binding target ids. */
export const clis = ["claude", "codex", "opencode"];

/**
 * Whether `cli` can run `server` (a definition or a public server). Codex has no SSE;
 * Claude Code does not start a stdio command in a working directory, Codex and OpenCode
 * do (docs/cli-mcp-qualification.md): MCP_CLI_CWD_UNSUPPORTED applies to Claude Code only.
 * No CLI gets a server with agent placeholders (docs/mcp.md#agent-placeholders): its
 * one configuration serves every session. `agentPlaceholders` marks a stored server;
 * a raw input is judged by its own arguments, working directory and environment.
 */
export function cliSupport(cli, server) {
  if (server.agentPlaceholders === true || usesAgentPlaceholders(server, server.env))
    return { supported: false, reason: "placeholder" };
  if (cli === "codex" && server.transport === "sse")
    return { supported: false, reason: "transport" };
  if (cli === "claude" && server.transport === "stdio" && server.cwd)
    return { supported: false, reason: "cwd" };
  return { supported: true };
}

const refusals = {
  transport: ["MCP_CLI_TRANSPORT_UNSUPPORTED", "cliTransportUnsupported"],
  cwd: ["MCP_CLI_CWD_UNSUPPORTED", "cliCwdUnsupported"],
  placeholder: ["MCP_CLI_PLACEHOLDER_UNSUPPORTED", "cliPlaceholderUnsupported"],
};

/** The CLIs `wanted` names, in canonical order; anything else is refused (400). */
export function cliTargets(wanted) {
  if (!Array.isArray(wanted) || wanted.some((cli) => !clis.includes(cli)))
    throw problem(serverMessages.mcpServers.invalidTarget, 400);
  return clis.filter((cli) => wanted.includes(cli));
}

/** Refuses (400) when one of `targets` cannot run `server`; nothing is stored then. */
export function requireCliSupport(targets, server) {
  for (const cli of targets) {
    const support = cliSupport(cli, server);
    if (support.supported) continue;
    const [code, key] = refusals[support.reason];
    throw Object.assign(problem(serverMessages.mcpServers[key], 400), { code });
  }
}

/** nativeMcp's input for a stored definition and its secrets. */
export function cliInput(definition, secrets) {
  return {
    transport: definition.transport,
    url: definition.url ?? undefined,
    command: definition.command ?? undefined,
    args: definition.args ?? [],
    cwd: definition.cwd ?? null,
    auth: definition.auth ?? "headers",
    oauthScope: definition.oauthScope ?? null,
    headers: { ...secrets.headers },
    env: { ...secrets.env },
  };
}

/** Whether every string in `value` (keys included) has a UTF-8 form. */
const wellFormed = (value) =>
  typeof value === "string"
    ? value.isWellFormed()
    : Array.isArray(value)
      ? value.every(wellFormed)
      : value && typeof value === "object"
        ? Object.entries(value).every(
            ([key, item]) => wellFormed(key) && wellFormed(item),
          )
        : true;

/**
 * The native entry of a stored definition. A value no CLI file can hold (a lone
 * surrogate, stored before input checks refused it) throws, so the reconciler fails
 * only this entry, never the whole file.
 */
export function cliEntry(cli, definition, secrets) {
  const entry = {
    ...nativeMcp(cli, cliInput(definition, secrets)),
    ...nativeTimeouts(cli, definition),
  };
  if (!wellFormed(entry)) throw new Error("MCP entry has no UTF-8 form");
  return entry;
}

/** JSON with keys sorted at every level and undefined members left out. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** What AgentPier records for a native entry: its hash, never the entry. */
export const entryHash = (entry) =>
  createHash("sha256").update(canonicalJson(entry)).digest("hex");

const extra = (entry, keys) => Object.keys(entry).filter((key) => !keys.includes(key));
/** Like `extra`, with the CLI's timeout keys allowed (read by `parse`). */
const extraOf = (cli) => (entry, keys) =>
  extra(entry, [...keys, ...nativeTimeoutKeys(cli)]);
const strings = (list) =>
  Array.isArray(list) && list.every((item) => typeof item === "string");
const unsupported = (keys) => ({ ok: false, reason: "unsupported-fields", keys });
const invalid = { ok: false, reason: "invalid" };
const fail = () => {
  throw new Error("invalid native MCP entry");
};

function stdio(command, args, env, cwd = null) {
  if (typeof command !== "string" || !command.trim() || !strings(args)) fail();
  if (cwd !== null && (typeof cwd !== "string" || !path.isAbsolute(cwd))) fail();
  return {
    ok: true,
    definition: {
      transport: "stdio",
      command,
      args,
      cwd,
      auth: "headers",
      oauthScope: null,
    },
    secrets: { headers: {}, env: { ...values(env ?? {}) } },
  };
}
/** `oauthScope` undefined: header auth; a string (possibly empty): OAuth. */
function remote(transport, url, headers, oauthScope) {
  if (typeof url !== "string") fail();
  mcpUrl(url);
  const oauth = oauthScope !== undefined;
  return {
    ok: true,
    definition: {
      transport,
      url,
      command: null,
      args: [],
      cwd: null,
      auth: oauth ? "oauth" : "headers",
      oauthScope: oauth && oauthScope ? oauthScope : null,
    },
    secrets: { headers: oauth ? {} : { ...values(headers ?? {}, true) }, env: {} },
  };
}
function fromClaude(entry) {
  const extra = extraOf("claude");
  const type = entry.type ?? (entry.command !== undefined ? "stdio" : undefined);
  if (type === "stdio") {
    const keys = extra(entry, ["type", "command", "args", "env"]);
    return keys.length
      ? unsupported(keys)
      : stdio(entry.command, entry.args ?? [], entry.env);
  }
  if (type === "http" || type === "sse") {
    const keys = extra(entry, ["type", "url", "headers"]);
    return keys.length ? unsupported(keys) : remote(type, entry.url, entry.headers);
  }
  return unsupported(["type"]);
}
function fromCodex(entry) {
  const extra = extraOf("codex");
  if (entry.enabled === false) return unsupported(["enabled"]);
  if (entry.command !== undefined) {
    const keys = extra(entry, ["command", "args", "env", "cwd", "enabled"]);
    return keys.length
      ? unsupported(keys)
      : stdio(entry.command, entry.args ?? [], entry.env, entry.cwd ?? null);
  }
  const keys = extra(entry, ["url", "http_headers", "scopes", "enabled"]);
  if (keys.length) return unsupported(keys);
  if (entry.scopes === undefined) return remote("http", entry.url, entry.http_headers);
  if (!strings(entry.scopes) || !entry.scopes.length || entry.http_headers !== undefined)
    return unsupported(["scopes"]);
  return remote("http", entry.url, {}, entry.scopes.join(" "));
}
function fromOpenCode(entry) {
  const extra = extraOf("opencode");
  if (entry.enabled === false) return unsupported(["enabled"]);
  if (entry.type === "local") {
    const keys = extra(entry, ["type", "command", "environment", "cwd", "enabled"]);
    if (keys.length) return unsupported(keys);
    if (!Array.isArray(entry.command) || !entry.command.length) fail();
    const [command, ...args] = entry.command;
    return stdio(command, args, entry.environment, entry.cwd ?? null);
  }
  if (entry.type !== "remote") return unsupported(["type"]);
  const keys = extra(entry, ["type", "url", "headers", "oauth", "enabled"]);
  if (keys.length) return unsupported(keys);
  if (entry.oauth === undefined) return remote("http", entry.url, entry.headers);
  if (!record(entry.oauth) || extra(entry.oauth, ["scope"]).length || entry.headers)
    return unsupported(["oauth"]);
  if (entry.oauth.scope !== undefined && typeof entry.oauth.scope !== "string") fail();
  return remote("http", entry.url, {}, entry.oauth.scope ?? "");
}

/**
 * Where a parsed entry refers to the CLI's environment or a file instead of holding
 * the value: field names (`command`, `args`, `cwd`, `url`) and header or environment
 * names, never a value. Another CLI or an agent would get such a value literally.
 */
function references({ definition, secrets }) {
  const has = hasReference;
  const fields = ["command", "args", "cwd", "url"].filter((field) =>
    Array.isArray(definition[field])
      ? definition[field].some(has)
      : has(definition[field]),
  );
  const named = (map) => Object.keys(map).filter((name) => has(map[name]));
  return [...fields, ...named(secrets.headers), ...named(secrets.env)];
}

function parse(cli, entry) {
  const parsed =
    cli === "claude"
      ? fromClaude(entry)
      : cli === "codex"
        ? fromCodex(entry)
        : fromOpenCode(entry);
  if (!parsed.ok) return parsed;
  const timeouts = timeoutsFromNative(cli, entry);
  if (timeouts.key) return unsupported([timeouts.key]);
  Object.assign(parsed.definition, timeouts.values);
  return parsed;
}

/**
 * A native entry as central fields, `{ ok, definition, secrets }`, or `{ ok: false,
 * reason }` when AgentPier could not take it over without losing something: settings
 * it does not manage (a timeout outside the bounds of mcp-timeouts.js included), a disabled entry, malformed values, or references to the CLI's
 * environment (`env-references`, with the `names` that use them). OpenCode's `remote`
 * reads as HTTP; it cannot tell SSE apart.
 */
export function centralFromNative(cli, entry) {
  if (!record(entry)) return invalid;
  let parsed;
  try {
    parsed = parse(cli, entry);
  } catch {
    parsed = invalid;
  }
  // A reference can make a field unreadable (a URL host, a relative cwd): name it.
  const names =
    parsed === invalid ? referenceNames(entry) : parsed.ok ? references(parsed) : [];
  return names.length ? { ok: false, reason: "env-references", names } : parsed;
}

/** Equal for identical servers found in different CLIs; holds values, never leaves the server. */
export const contentKey = (parsed) =>
  canonicalJson({ ...parsed.definition, ...parsed.secrets });

/**
 * A valid central name close to `name` that `taken` (lower-case names) does not hold.
 * A valid free name is kept.
 */
export function proposeName(name, taken) {
  let base = String(name)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z]+/, "")
    .slice(0, 30);
  if (!base) base = "mcp";
  if (namePattern.test(base) && !taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 30 - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
