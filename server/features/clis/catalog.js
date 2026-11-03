// Browser-safe: the web app bundles this file, so it imports nothing from Node.
import codex from "./codex/definition.js";
import claude from "./claude/definition.js";
import opencode from "./opencode/definition.js";

const freeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

// Every definition is deep-frozen once, here, so a definition file stays plain data.
const definitions = freeze({ codex, claude, opencode });

/** The coding CLIs, in the order every list and API shows them. */
export const CODING_CLI_IDS = Object.freeze(["codex", "claude", "opencode"]);

export function codingCliIds() {
  return [...CODING_CLI_IDS];
}

export function isCodingCli(id) {
  return typeof id === "string" && Object.hasOwn(definitions, id);
}

export function cliDefinition(id) {
  if (!isCodingCli(id)) throw new TypeError(`Unknown coding CLI: ${String(id)}`);
  return definitions[id];
}

export function cliName(id) {
  return cliDefinition(id).name;
}
