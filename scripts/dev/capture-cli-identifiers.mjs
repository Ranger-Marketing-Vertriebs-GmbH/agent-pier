// Replaces the install and session identifiers of recorded CLI requests with constants,
// so fixtures do not carry machine-specific ids and re-recording yields stable files.
//
// Claude Code: `metadata.user_id` JSON (`device_id`, `session_id`) and the
// `x-claude-code-session-id` header. Codex: `x-codex-turn-metadata` JSON (header and
// `client_metadata`) `installation_id`/`session_id`/`thread_id`, `x-codex-installation-id`,
// and the `session-id`/`thread-id` headers. Every occurrence of a collected value (also
// inside `prompt_cache_key`, `x-client-request-id` or `x-codex-window-id`) is replaced, so
// requests of one session keep sharing their ids.

const parseJson = (text) => {
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};

const header = (headers, name) => {
  const key = Object.keys(headers ?? {}).find((entry) => entry.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
};

const nonEmpty = (value) => typeof value === "string" && value !== "";

/** `[kind, value]` pairs of the identifiers a recorded request carries. */
export function identifiersOf({ headers, body }) {
  const found = [];
  const add = (kind, value) => {
    if (nonEmpty(value)) found.push([kind, value]);
  };
  const user = parseJson(body?.metadata?.user_id);
  add("device", user?.device_id);
  add("session", user?.session_id);
  add("session", header(headers, "x-claude-code-session-id"));
  for (const metadata of [
    parseJson(header(headers, "x-codex-turn-metadata")),
    parseJson(body?.client_metadata?.["x-codex-turn-metadata"]),
  ]) {
    add("installation", metadata?.installation_id);
    add("session", metadata?.session_id);
    add("session", metadata?.thread_id);
  }
  add("installation", body?.client_metadata?.["x-codex-installation-id"]);
  add("installation", header(headers, "x-codex-installation-id"));
  add("session", body?.client_metadata?.session_id);
  add("session", body?.client_metadata?.thread_id);
  add("session", header(headers, "session-id"));
  add("session", header(headers, "thread-id"));
  return found;
}

const CONSTANTS = {
  session: (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  installation: (n) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
  device: (n) => `fixture-device-id-${n}`,
};

/** True for a value produced by the constants above. */
export const isFixtureIdentifier = (value) =>
  /^00000000-0000-4000-[89]000-\d{12}$/.test(value) ||
  /^fixture-device-id-\d+$/.test(value);

/**
 * Stateful scrubber for one recording run: `mapping(record)` returns the `[from, to]`
 * replacements for the record (numbering new values in order of first appearance) and
 * `scrub(record)` applies them to every string of the record.
 */
export function createIdentifierScrubber() {
  const assigned = new Map();
  const counters = { session: 0, installation: 0, device: 0 };
  const mapping = (record) => {
    for (const [kind, value] of identifiersOf(record)) {
      if (assigned.has(value) || isFixtureIdentifier(value)) continue;
      counters[kind] += 1;
      assigned.set(value, CONSTANTS[kind](counters[kind]));
    }
    return [...assigned].sort((a, b) => b[0].length - a[0].length);
  };
  const replaceAll = (text, pairs) =>
    pairs.reduce((out, [from, to]) => out.split(from).join(to), text);
  const scrub = (record) => {
    const pairs = mapping(record);
    const walk = (value) => {
      if (typeof value === "string") return replaceAll(value, pairs);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
      return value;
    };
    return walk(record);
  };
  return { mapping, scrub, replaceAll };
}
