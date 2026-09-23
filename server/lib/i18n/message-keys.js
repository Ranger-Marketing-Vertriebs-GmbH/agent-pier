// Stable message keys are catalog paths such as "requests.invalid". Servers keep
// sending their German text; browsers resolve the key in the active language.
const keyPattern = /^[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+$/;
const argLimit = 8;
// Catalog messages are short; longer text (CLI output, logs) skips pattern matching.
const patternTextLimit = 2000;
const sentinel = (index) => `\u0000${index}\u0000`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function messageEntries(tree, prefix = "") {
  const entries = [];
  for (const [name, value] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof value === "string" || typeof value === "function")
      entries.push([key, value]);
    else if (value && typeof value === "object")
      entries.push(...messageEntries(value, key));
  }
  return entries;
}

// Renders a catalog function with placeholders and turns the result into an anchored
// pattern, so a finished message can be traced back to its key and arguments.
function template(key, render) {
  const count = Math.min(render.length, argLimit);
  if (!count) return null;
  let text;
  try {
    text = render(...Array.from({ length: count }, (_, index) => sentinel(index)));
  } catch {
    return null;
  }
  if (typeof text !== "string") return null;
  const seen = new Set();
  let source = "";
  let literal = 0;
  // split() alternates literal text (even positions) and placeholder numbers (odd).
  const parts = text.split(/\u0000(\d+)\u0000/);
  for (const [position, part] of parts.entries()) {
    if (position % 2 === 1) {
      const name = `a${part}`;
      source += seen.has(name) ? `\\k<${name}>` : `(?<${name}>[\\s\\S]*?)`;
      seen.add(name);
    } else {
      source += escapeRegExp(part);
      literal += part.length;
    }
  }
  if (!seen.size || literal === 0) return null;
  return { key, count, literal, pattern: new RegExp(`^${source}$`) };
}

/** Builds a reverse index from finished catalog text to its stable key and arguments. */
export function createMessageIndex(tree) {
  const exact = new Map();
  const templates = [];
  for (const [key, value] of messageEntries(tree)) {
    if (typeof value === "string") {
      if (value && !exact.has(value)) exact.set(value, key);
    } else {
      const entry = template(key, value);
      if (entry) templates.push(entry);
    }
  }
  // Prefer the most specific template when two patterns accept the same text.
  templates.sort((a, b) => b.literal - a.literal);
  return function identify(text) {
    if (typeof text !== "string" || !text) return null;
    const key = exact.get(text);
    if (key) return { key };
    if (text.length > patternTextLimit) return null;
    for (const entry of templates) {
      const match = entry.pattern.exec(text);
      if (!match) continue;
      const args = Array.from(
        { length: entry.count },
        (_, index) => match.groups[`a${index}`] ?? "",
      );
      return { key: entry.key, args };
    }
    return null;
  };
}

/** Resolves a stable key in a catalog; undefined lets callers keep the server text. */
export function resolveMessage(tree, key, args) {
  if (typeof key !== "string" || !keyPattern.test(key)) return undefined;
  let value = tree;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
      return undefined;
    value = value[part];
  }
  if (typeof value === "string") return value;
  if (typeof value !== "function") return undefined;
  const values = Array.isArray(args) ? args.slice(0, argLimit) : [];
  if (values.some((item) => !["string", "number", "boolean"].includes(typeof item)))
    return undefined;
  try {
    const text = value(...values);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}
