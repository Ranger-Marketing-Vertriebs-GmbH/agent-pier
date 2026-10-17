import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

/**
 * Optional per-server timeouts in whole seconds (docs/mcp.md, "Timeouts"). Startup:
 * up to 10 minutes, enough for a first `npx`/`uvx` download, short enough that a
 * server that never answers does not hold a session start for long. Tool calls: up to
 * an hour, for long analyses (decompilers, builds); beyond that an agent turn waits on
 * one call for longer than anyone watches it.
 */
export const timeoutBounds = Object.freeze({
  startupTimeoutSec: Object.freeze({ min: 1, max: 600 }),
  toolTimeoutSec: Object.freeze({ min: 1, max: 3600 }),
});
export const timeoutFields = Object.keys(timeoutBounds);

const messageKeys = {
  startupTimeoutSec: "invalidStartupTimeout",
  toolTimeoutSec: "invalidToolTimeout",
};
const within = (field, value) =>
  Number.isInteger(value) &&
  value >= timeoutBounds[field].min &&
  value <= timeoutBounds[field].max;

/**
 * A timeout from a create or update body: undefined keeps the stored one, null or ""
 * clears it, a whole number of seconds within the bounds sets it. Anything else is
 * refused (400 MCP_SERVER_TIMEOUT_INVALID with the `field`).
 */
export function cleanTimeout(field, value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (within(field, value)) return value;
  throw Object.assign(problem(serverMessages.mcpServers[messageKeys[field]], 400), {
    code: "MCP_SERVER_TIMEOUT_INVALID",
    field,
  });
}

/** A stored timeout; one outside the bounds (a crafted backup) reads as none. */
export const readTimeout = (field, value) => (within(field, value) ? value : null);

/** The public fields of the timeouts a definition sets. */
export const publicTimeouts = (definition) =>
  Object.fromEntries(
    timeoutFields
      .filter((field) => definition[field] != null)
      .map((field) => [field, definition[field]]),
  );

/**
 * The native keys of a definition's timeouts (docs/cli-mcp-qualification.md). Codex has
 * both in seconds. Claude Code and OpenCode have one per-server `timeout` in
 * milliseconds that bounds each tool call (OpenCode: every request, connecting
 * included); it carries the tool timeout. Neither has a per-server startup timeout.
 */
export function nativeTimeouts(cli, definition) {
  const startup = definition.startupTimeoutSec ?? null;
  const tool = definition.toolTimeoutSec ?? null;
  if (cli === "codex")
    return {
      ...(startup !== null ? { startup_timeout_sec: startup } : {}),
      ...(tool !== null ? { tool_timeout_sec: tool } : {}),
    };
  return tool !== null ? { timeout: tool * 1000 } : {};
}

/** The native timeout keys of `cli`, read by `timeoutsFromNative`. */
export const nativeTimeoutKeys = (cli) =>
  cli === "codex" ? ["startup_timeout_sec", "tool_timeout_sec"] : ["timeout"];

/**
 * The central timeouts of a native entry, `{ values }`, or `{ key }` naming the first
 * key AgentPier cannot hold: a value outside the bounds or not in whole seconds.
 */
export function timeoutsFromNative(cli, entry) {
  const values = { startupTimeoutSec: null, toolTimeoutSec: null };
  const read = (key, field, scale) => {
    if (entry[key] === undefined) return true;
    const value = typeof entry[key] === "number" ? entry[key] / scale : NaN;
    if (!within(field, value)) return false;
    values[field] = value;
    return true;
  };
  if (cli === "codex") {
    if (!read("startup_timeout_sec", "startupTimeoutSec", 1))
      return { key: "startup_timeout_sec" };
    if (!read("tool_timeout_sec", "toolTimeoutSec", 1))
      return { key: "tool_timeout_sec" };
  } else if (!read("timeout", "toolTimeoutSec", 1000)) return { key: "timeout" };
  return { values };
}

/** The timeouts of a stored `servers` row. */
export const rowTimeouts = (row) => ({
  startupTimeoutSec: readTimeout("startupTimeoutSec", row.startup_timeout_sec),
  toolTimeoutSec: readTimeout("toolTimeoutSec", row.tool_timeout_sec),
});

/** The timeouts of a full definition (stored merged with a patch); none is null. */
export const inputTimeouts = (input) =>
  Object.fromEntries(
    timeoutFields.map((field) => [field, cleanTimeout(field, input[field]) ?? null]),
  );
