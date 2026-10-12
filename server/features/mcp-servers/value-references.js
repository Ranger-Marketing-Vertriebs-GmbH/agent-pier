import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

/**
 * Claude Code's `${VAR}` and `${VAR:-default}`, OpenCode's `{env:VAR}` and
 * `{file:path}`: references a CLI expands itself, each in its own way.
 */
const reference = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}|\{(?:env|file):[^}]+\}/;

/** Whether `value` is a string holding a reference. */
export const hasReference = (value) => typeof value === "string" && reference.test(value);

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
 */
export function requireLiteralValues(input) {
  if (!input || typeof input !== "object") return;
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
