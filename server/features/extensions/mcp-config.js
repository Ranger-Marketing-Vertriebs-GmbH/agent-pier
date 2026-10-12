import { serverMessages } from "../../lib/i18n/de.js";
import { assertUnlinkedPath } from "../../lib/config-boundary.js";
import fs from "node:fs";
import path from "node:path";

import { randomUUID } from "node:crypto";
import { editConfigResult } from "./config-edit.js";
import { configParses, deepFreeze, parseNative, rememberTree } from "./config-parse.js";
import { configCache } from "./native-config-cache.js";
import { problem } from "../../lib/storage.js";

export const CLI_CONFIG_CHANGED = "CLI_CONFIG_CHANGED";
export const CLI_CONFIG_TOO_LARGE = "CLI_CONFIG_TOO_LARGE";
/**
 * The largest native CLI configuration AgentPier reads. Claude Code's ~/.claude.json
 * holds its project history and grows to many MiB on busy machines.
 */
export const CLI_CONFIG_MAX_BYTES = 64 * 1024 * 1024;
export { CLI_CONFIG_LAYOUT } from "./config-edit.js";

export const own = (obj, key) => Object.hasOwn(obj, key);
export const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
export function values(value = {}, headers = false) {
  if (!record(value) || Object.keys(value).length > 100)
    throw problem(serverMessages.extensions.invalidEnvironmentOrHeadersObject);
  for (const [key, item] of Object.entries(value))
    if (
      !(headers ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(
        key,
      ) ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      typeof item !== "string" ||
      item.length > 16384 ||
      /[\x00\r\n]/.test(item)
    )
      throw problem(serverMessages.extensions.invalidEnvironmentOrHeader);
  return value;
}
/** Validate a remote MCP URL (no credentials, no fragment, http/https) and return its href. */
export function mcpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw problem(serverMessages.extensions.invalidMcpUrl);
  }
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f\\]/.test(value) ||
    url.username ||
    url.password ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw problem(serverMessages.extensions.mcpUrlCredentialsForbidden);
  return url.href;
}
/**
 * A server in a CLI's native form (docs/cli-mcp-qualification.md). OAuth servers carry
 * no static headers: Claude Code and OpenCode run the login when the server asks,
 * Codex with `codex mcp login`. Codex and OpenCode start a stdio command in its
 * working directory; Claude Code does not (MCP_CLI_CWD_UNSUPPORTED applies to it only).
 */
export function nativeMcp(tool, entry) {
  if (entry.transport === "stdio") {
    if (tool === "opencode")
      return {
        type: "local",
        command: [entry.command, ...entry.args],
        environment: entry.env,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        enabled: true,
      };
    return {
      ...(tool === "claude" ? { type: "stdio" } : {}),
      command: entry.command,
      args: entry.args,
      env: entry.env,
      ...(tool === "codex" && entry.cwd ? { cwd: entry.cwd } : {}),
    };
  }
  const oauth = entry.auth === "oauth";
  // No header map at all when there are none: then a header server without headers
  // and an OAuth server read the same in Claude Code and Codex, as they behave.
  const headers =
    !oauth && Object.keys(entry.headers || {}).length ? entry.headers : null;
  if (tool === "codex") {
    if (!oauth) return { url: entry.url, ...(headers ? { http_headers: headers } : {}) };
    const scopes = (entry.oauthScope || "").split(/\s+/).filter(Boolean);
    return { url: entry.url, ...(scopes.length ? { scopes } : {}) };
  }
  if (tool === "claude")
    return {
      type: entry.transport === "sse" ? "sse" : "http",
      url: entry.url,
      ...(headers ? { headers } : {}),
    };
  return {
    type: "remote",
    url: entry.url,
    ...(oauth
      ? { oauth: entry.oauthScope ? { scope: entry.oauthScope } : {} }
      : headers
        ? { headers }
        : {}),
    enabled: true,
  };
}
export function publicMcp(name, entry, source) {
  let origin = "";
  try {
    origin = new URL(entry.url).origin;
  } catch {
    /* Existing command server or invalid URL. */
  }
  const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
  return {
    name,
    source,
    transport: entry.url ? "http" : "stdio",
    command: typeof command === "string" ? command : "",
    url: origin,
    argumentCount: Array.isArray(entry.command)
      ? Math.max(0, entry.command.length - 1)
      : Array.isArray(entry.args)
        ? entry.args.length
        : 0,
    environmentKeys: Object.keys(entry.env || entry.environment || {}),
    headerKeys: Object.keys(entry.http_headers || entry.headers || {}),
    enabled: entry.enabled !== false,
  };
}
export function safePath(target, boundary) {
  assertUnlinkedPath(target, boundary, {
    outside: serverMessages.extensions.targetOutsideProfile,
    linked: serverMessages.extensions.linkedPathsReadOnly,
  });
}
export function textFile(file, boundary) {
  safePath(file, boundary);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile())
      throw problem(serverMessages.extensions.invalidCliConfigFile, 409);
    if (stat.size > CLI_CONFIG_MAX_BYTES)
      throw Object.assign(problem(serverMessages.extensions.cliConfigTooLarge, 409), {
        code: CLI_CONFIG_TOO_LARGE,
      });
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}
function statOf(file) {
  try {
    return fs.statSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
/**
 * The file's `{ file, text, data }`. An unchanged file comes from the parse cache
 * (native-config-cache.js, or `cache` in tests); `data` is frozen either way. A JSON file's tree stays
 * with the returned object for an edit (config-parse.js `treeOf`).
 */
export function readConfig(file, boundary, tool, cache = configCache) {
  safePath(file, boundary);
  const before = statOf(file);
  const cached =
    before?.isFile() && cache.cached(file, tool, before, () => textFile(file, boundary));
  if (cached)
    return rememberTree({ file, text: cached.text, data: cached.data }, cached.tree);
  const text = textFile(file, boundary);
  let parsed;
  try {
    if (text.trim()) configParses.reads++;
    parsed = parseNative(text, tool);
    if (!record(parsed.data)) throw new Error();
  } catch {
    throw problem(serverMessages.extensions.invalidExistingCliConfig, 409);
  }
  const data = deepFreeze(parsed.data);
  const after = before && statOf(file);
  if (after && after.mtimeMs === before.mtimeMs && after.size === before.size)
    cache.remember(file, tool, before, { text, data, tree: parsed.tree });
  return rememberTree({ file, text, data }, parsed.tree);
}
/**
 * Replaces `file` with `after` while it still holds `before` (compare-and-swap). With
 * `parsed` (`{ tool, data, tree }`, the verified parse of `after`) the next read of the
 * file needs no parse.
 */
export function atomicText(file, boundary, before, after, parsed = null) {
  safePath(file, boundary);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, after, { flag: "wx", mode: 0o600 });
    const written = fs.statSync(temp);
    safePath(file, boundary);
    configCache.forget(file);
    if (textFile(file, boundary) !== before)
      throw Object.assign(problem(serverMessages.extensions.cliConfigChanged, 409), {
        code: CLI_CONFIG_CHANGED,
      });
    fs.renameSync(temp, file);
    // A rename keeps the device, inode, size and time the temporary file had.
    if (parsed)
      configCache.remember(file, parsed.tool, written, {
        text: after,
        data: deepFreeze(parsed.data),
        tree: parsed.tree,
      });
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
/**
 * Sets (or with `entry` undefined removes) `config.data[key][name]` in the file, editing
 * only that entry's own text (config-edit.js), with compare-and-swap on `config.text`.
 */
export function updateConfig(config, boundary, tool, key, name, entry) {
  const result = editConfigResult(config, tool, key, name, entry);
  if (result.text !== config.text)
    atomicText(config.file, boundary, config.text, result.text, { tool, ...result });
}
