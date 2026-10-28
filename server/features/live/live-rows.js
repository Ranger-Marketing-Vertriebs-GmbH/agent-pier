// Values as ChatSync rows for the live hub's `rows` topics (`state`, `agent.list`);
// the browser rebuilds them with `applyListSync` (web/lib/live/list-sync.js).
import { createHash } from "node:crypto";

/** A ChatSync cursor as the browser may send it back. */
export const LIST_CURSOR = /^[A-Za-z0-9-]{1,64}$/;

const keyed = (items) =>
  items.every((item) => item && typeof item.id === "string") &&
  new Set(items.map((item) => item.id)).size === items.length;
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The list as ChatSync rows: an array of items with unique ids becomes one row per
 * item, an object one row per key, anything else one row for the section. `shape`
 * says how each section is rebuilt, so empty sections survive the round trip.
 */
export function listRows(list) {
  const shape = {};
  const messages = [];
  for (const [section, value] of Object.entries(list || {})) {
    if (value === undefined) continue;
    if (Array.isArray(value) && keyed(value)) {
      shape[section] = "array";
      for (const item of value)
        messages.push({ id: `${section}/${item.id}`, section, value: item });
    } else if (plain(value)) {
      shape[section] = "object";
      for (const [key, entry] of Object.entries(value))
        if (entry !== undefined)
          messages.push({ id: `${section}/${key}`, section, key, value: entry });
    } else {
      shape[section] = "value";
      messages.push({ id: section, section, value });
    }
  }
  return { shape, messages };
}

/** JSON with object keys sorted, so equal values hash equally whatever their key order. */
export function stableJson(value) {
  return JSON.stringify(value, (_key, entry) =>
    plain(entry) && [Object.prototype, null].includes(Object.getPrototypeOf(entry))
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        )
      : entry,
  );
}

/** SHA-256 of the stable JSON of `value`. */
export const digestOf = (value) =>
  createHash("sha256")
    .update(stableJson(value) ?? "")
    .digest("hex");
