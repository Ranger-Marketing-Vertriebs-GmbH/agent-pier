import { createHash } from "node:crypto";

// Store hashes instead of duplicating MCP secrets in synchronization metadata.
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function entries(values) {
  return Object.fromEntries(
    Object.entries(values).flatMap(([field, value]) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value).map(([name, definition]) => [
            JSON.stringify([field, name]),
            definition,
          ])
        : [[JSON.stringify([field]), value]],
    ),
  );
}
export function fingerprint(values) {
  return Object.fromEntries(
    Object.entries(entries(values)).map(([key, value]) => [key, hash(value)]),
  );
}
export function synchronize(current, incoming, baseline, conflicts) {
  const shared = entries(current),
    changed = entries(incoming);
  const result = structuredClone(current);
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(changed)])) {
    const previous = baseline[key],
      next = changed[key] === undefined ? undefined : hash(changed[key]);
    if (previous === next) continue;
    const canonical = shared[key] === undefined ? undefined : hash(shared[key]);
    const [field, name] = JSON.parse(key);
    if (canonical !== previous && canonical !== next) {
      conflicts.push([field, name].filter(Boolean).join("."));
      continue;
    }
    if (name === undefined) {
      if (next === undefined) delete result[field];
      else result[field] = changed[key];
    } else {
      const definitions = new Map(Object.entries(result[field] || {}));
      if (next === undefined) definitions.delete(name);
      else definitions.set(name, changed[key]);
      result[field] = Object.fromEntries(definitions);
    }
  }
  return result;
}
