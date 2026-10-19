import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { requireValidPlaceholders } from "./agent-placeholders.js";

/**
 * Claude Code's `${…}` (any non-empty content, `${VAR:-default}` included), OpenCode's
 * `{env:VAR}` and `{file:path}`: references a CLI expands itself, each in its own
 * way. A `$` without braces (`$VAR`, `pa$$word`) is no reference.
 */
const openers = ["${", "{env:", "{file:"];

/**
 * Whether `value` holds `opener`, then at least one character other than `}`, then
 * `}`. A linear scan: a regular expression backtracks quadratically on a long run of
 * openers without a closing brace. An opener whose next `}` follows directly is
 * empty, and the next candidate starts after that `}`.
 */
function hasOpened(value, opener) {
  for (let start = value.indexOf(opener); start !== -1;) {
    const body = start + opener.length;
    const close = value.indexOf("}", body);
    if (close === -1) return false;
    if (close > body) return true;
    start = value.indexOf(opener, close + 1);
  }
  return false;
}

/** Whether `value` is a string holding a reference. */
export const hasReference = (value) =>
  typeof value === "string" && openers.some((opener) => hasOpened(value, opener));

const inList = (value) => (Array.isArray(value) ? value.some(hasReference) : false);

/**
 * Where a raw object refers to the environment or a file: the keys of its string or
 * string-list members that hold one, and for a nested map the names inside it. Names
 * only, never a value.
 */
export function referenceNames(entry) {
  const names = [];
  for (const [key, value] of Object.entries(entry)) {
    if (hasReference(value) || inList(value)) names.push(key);
    else if (value && typeof value === "object" && !Array.isArray(value))
      names.push(...Object.keys(value).filter((name) => hasReference(value[name])));
  }
  return names;
}

export const VALUE_REFERENCE = "MCP_SERVER_VALUE_REFERENCE";

/**
 * Refuses (400 MCP_SERVER_VALUE_REFERENCE) a server input whose values hold a
 * reference: AgentPier stores literal values, and the CLIs would expand such a
 * reference each in their own way, agents not at all. Only the fields present are
 * checked, so a stored server is never refused for what it already holds. The error
 * names the `field` and, for headers and environment, the `names`; never a value.
 * The agent placeholders are the one exception (agent-placeholders.js): a value in
 * their namespace must be a valid placeholder (400 MCP_SERVER_PLACEHOLDER).
 */
export function requireLiteralValues(input, transport = input?.transport) {
  if (!input || typeof input !== "object") return;
  requireValidPlaceholders(input, transport);
  const refuse = (field, names = []) => {
    throw Object.assign(problem(serverMessages.mcpServers.valueReference, 400), {
      code: VALUE_REFERENCE,
      field,
      names,
    });
  };
  for (const field of ["url", "command", "args", "cwd"])
    if (hasReference(input[field]) || inList(input[field])) refuse(field);
  for (const field of ["headers", "env"]) {
    const map = input[field];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    const names = Object.keys(map).filter((name) => hasReference(map[name]));
    if (names.length) refuse(field, names);
  }
}

/**
 * The fields of `patch` whose value differs from the stored server `row` (database
 * columns): an unchanged stored value, written before references were refused, never
 * blocks a save. Header and environment values are only ever the ones sent.
 */
export function changedValues(row, patch) {
  if (!patch || typeof patch !== "object") return {};
  const stored = {
    url: row.url ?? "",
    command: row.command ?? "",
    args: row.args ?? "[]",
    cwd: row.cwd ?? "",
  };
  const changed = { transport: row.transport, headers: patch.headers, env: patch.env };
  for (const field of ["url", "command", "cwd"])
    if ((patch[field] ?? "") !== stored[field]) changed[field] = patch[field];
  if (patch.args !== undefined && JSON.stringify(patch.args) !== stored.args)
    changed.args = patch.args;
  return changed;
}
