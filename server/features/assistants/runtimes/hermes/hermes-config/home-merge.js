import { parse, stringify } from "yaml";

// Hermes writes into the files AgentPier compiles (`_config_version`,
// `onboarding.seen.*`, `gateway.multiplex_profiles`, `command_allowlist` after an
// "always" approval, Telegram tokens in .env): those keys are runtime state. A merge
// replaces only the keys AgentPier owns and keeps every other key where it was;
// it reads and writes whole documents, so a key is never written twice (Hermes's
// YAML loader refuses duplicate keys, hermes_yaml.py).

// Hermes reads YAML 1.1 (hermes_yaml.py): `off`, `yes` and `n` are booleans there,
// so strings like them are quoted on the way out and read as Hermes reads them.
const yaml11 = { version: "1.1" };
const isMap = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** A refusal of a Hermes home file AgentPier cannot merge into. */
export class HermesHomeError extends Error {
  constructor(file, cause) {
    super(`The Hermes home's ${file} cannot be read: ${cause?.message || cause}`);
    this.name = "HermesHomeError";
    this.code = "HERMES_HOME_UNREADABLE";
    this.file = file;
  }
}

function readConfig(text) {
  if (!text?.trim()) return {};
  let value;
  try {
    // A duplicate key (the spike appended text to a written file) keeps the last
    // value, as a YAML reader that accepts it does; the merge writes it once.
    value = parse(text, { ...yaml11, uniqueKeys: false });
  } catch (error) {
    throw new HermesHomeError("config.yaml", error);
  }
  if (value == null) return {};
  if (!isMap(value)) throw new HermesHomeError("config.yaml", "not a mapping");
  return value;
}

function setPath(root, path, value) {
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (!isMap(node[key])) node[key] = {};
    node = node[key];
  }
  const last = path.at(-1);
  if (value === undefined) delete node[last];
  else node[last] = structuredClone(value);
}

/**
 * config.yaml after AgentPier's `entries` (`[[path, value], …]`, a value of
 * undefined removing the key) over the `existing` text. New keys follow in entry
 * order; keys Hermes wrote stay. Throws HermesHomeError for a file that is no YAML
 * mapping. Pure.
 */
export function mergeConfig(existing, entries) {
  const config = readConfig(existing);
  for (const [path, value] of entries) setPath(config, path, value);
  return stringify(config, { ...yaml11, lineWidth: 0 });
}

/** The parsed config.yaml text as Hermes reads it (tests and callers that compare). */
export const readHermesConfig = (text) => readConfig(text);

const envLine = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

// Single quotes keep the value literal for python-dotenv (no escapes, no `${}`
// interpolation); a key holding a quote or a line break is refused, never mangled.
function envValue(name, value) {
  const text = String(value);
  if (/['\r\n]/.test(text)) throw new TypeError(`${name} holds a quote or line break.`);
  return `'${text}'`;
}

// A name in `owned`: listed, or starting with an entry's text before a final "*".
const ownedName = (owned, name) =>
  owned.some((entry) =>
    entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : entry === name,
  );

/**
 * .env after AgentPier's values: every line of an `owned` name (an entry ending in
 * "*" owns every name it starts) is dropped, each name of `values` (all owned) is
 * written once where it first stood, or appended in name order; comments and other
 * names stay. Pure.
 */
export function mergeEnv(existing, owned, values) {
  const lines = existing ? existing.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const written = new Set();
  const out = [];
  for (const line of lines) {
    const name = line.match(envLine)?.[1];
    if (!name || !ownedName(owned, name)) {
      out.push(line);
      continue;
    }
    if (written.has(name) || values[name] === undefined) continue;
    written.add(name);
    out.push(`${name}=${envValue(name, values[name])}`);
  }
  for (const name of Object.keys(values).sort())
    if (!written.has(name)) out.push(`${name}=${envValue(name, values[name])}`);
  return out.length ? `${out.join("\n")}\n` : "";
}
