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
    // Removing a key below a section that is not there leaves the file as it is.
    if (!isMap(node[key]) && value === undefined) return;
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
/** The names a .env text sets. */
export const envNames = (text) =>
  new Set(
    (text || "")
      .split(/\r?\n/)
      .map((line) => line.match(envLine)?.[1])
      .filter(Boolean),
  );

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

// The credential pool row AgentPier owns in a home's auth.json: Hermes's
// `openai-codex` provider with the model proxy's credential (hermes-config/model.js).
export const agentPierPoolSource = "manual:agentpier";
const poolProvider = "openai-codex";
// What decides a row's use; Hermes's own status fields on it (last_status, …) stay.
const poolIdentity = ["auth_type", "access_token", "base_url", "source"];

/**
 * auth.json with AgentPier's pool row `entry` for openai-codex, or without it for
 * `entry` null; every other key and row Hermes keeps there stays. Returns `existing`
 * unchanged when nothing differs, undefined when there is no file and nothing to
 * write. A file that is no JSON object is Hermes's to repair: left as it is. Pure.
 */
export function mergeAuth(existing, entry) {
  let store = {};
  if (existing !== undefined) {
    try {
      store = JSON.parse(existing);
    } catch {
      return existing;
    }
    if (!isMap(store)) return existing;
  } else if (!entry) return undefined;
  const pool = isMap(store.credential_pool) ? { ...store.credential_pool } : {};
  const rows = Array.isArray(pool[poolProvider]) ? pool[poolProvider] : [];
  const ours = rows.find((row) => row?.source === agentPierPoolSource);
  const others = rows.filter((row) => row?.source !== agentPierPoolSource);
  const same = !!entry && !!ours && poolIdentity.every((key) => ours[key] === entry[key]);
  if (same || (!entry && !ours)) return existing;
  const next = entry ? [entry, ...others] : others;
  if (next.length) pool[poolProvider] = next;
  else delete pool[poolProvider];
  return `${JSON.stringify(
    {
      version: 1,
      ...store,
      providers: isMap(store.providers) ? store.providers : {},
      credential_pool: pool,
    },
    null,
    2,
  )}\n`;
}
