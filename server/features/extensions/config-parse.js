import { parseTree } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

/**
 * How often a native configuration was parsed: `reads` full parses of a file read,
 * `edits` tree parses of a text an edit already had (none when the read's tree is
 * reused). The verification parse of an edit's result is not counted. For tests.
 */
export const configParses = { reads: 0, edits: 0 };

const options = (tool) => ({
  allowTrailingComma: tool === "opencode",
  disallowComments: tool === "claude",
});

/** The JSON tree of `text` for `tool`, or an Error on any syntax error. */
export function jsonTree(text, tool) {
  const errors = [];
  const tree = parseTree(text, errors, options(tool));
  if (errors.length || !tree) throw new Error("invalid JSON");
  return tree;
}

/**
 * The value of a JSON tree. Duplicate keys throw: a configuration must not silently
 * choose one of two values. `__proto__` stays an ordinary member.
 */
export function jsonValue(node) {
  if (node.type === "array") return node.children.map(jsonValue);
  if (node.type !== "object") return node.value;
  const out = {};
  for (const property of node.children) {
    const [key, value] = property.children;
    if (Object.hasOwn(out, key.value)) throw new Error("Duplicate configuration keys");
    Object.defineProperty(out, key.value, {
      value: jsonValue(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** `{ data, tree }` for a native configuration text; `tree` only for JSON. */
export function parseNative(text, tool) {
  if (!text.trim()) return { data: {}, tree: null };
  if (tool === "codex") return { data: parseToml(text), tree: null };
  const tree = jsonTree(text, tool);
  return { data: jsonValue(tree), tree };
}

/** Freezes `value` deeply: a cached parse is shared by every reader. */
export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const plain = (value) => (typeof value?.toJSON === "function" ? value.toJSON() : value);

/** Deep equality as canonical JSON sees it: key order and undefined members do not count. */
export function sameValue(a, b) {
  a = plain(a);
  b = plain(b);
  if (a === b || Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a))
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  const keys = (value) => Object.keys(value).filter((key) => value[key] !== undefined);
  const left = keys(a);
  if (left.length !== keys(b).length) return false;
  return left.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

const trees = new WeakMap();
/** Remembers that `tree` is the JSON tree of `config.text` for this config object. */
export function rememberTree(config, tree) {
  if (tree) trees.set(config, tree);
  return config;
}
/** The remembered tree of exactly this config object, or undefined. */
export const treeOf = (config) => trees.get(config);
