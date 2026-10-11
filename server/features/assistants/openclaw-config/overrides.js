import { isLockedPath } from "./locked-core.js";
import { assistantProblem } from "../assistant-validation.js";

const segment = /^[A-Za-z0-9_-]{1,128}$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

export function validateOverride(target, value) {
  const parts = String(target).split(".");
  if (
    !target ||
    parts.some((p) => !segment.test(p) || forbidden.has(p)) ||
    isLockedPath(target) ||
    value === undefined
  )
    throw assistantProblem("invalid", 400);
  return { path: target, value: structuredClone(value) };
}

export function applyOverrides(config, overrides) {
  const result = structuredClone(config);
  for (const { path: target, value } of overrides) {
    const { path: valid } = validateOverride(target, value);
    const parts = valid.split(".");
    let node = result;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(node, part) || typeof node[part] !== "object" || !node[part])
        node[part] = {};
      node = node[part];
    }
    node[parts.at(-1)] = structuredClone(value);
  }
  return result;
}

export class OverrideStore {
  constructor(db) {
    this.db = db;
  }
  list() {
    return this.db
      .prepare("SELECT path, value, revision FROM openclaw_overrides ORDER BY path")
      .all()
      .map((row) => ({
        path: row.path,
        value: JSON.parse(row.value),
        revision: row.revision,
      }));
  }
  set(target, value) {
    const valid = validateOverride(target, value);
    this.db
      .prepare(
        `INSERT INTO openclaw_overrides (path, value, revision) VALUES (?, ?, 1)
         ON CONFLICT(path) DO UPDATE SET value = excluded.value, revision = revision + 1`,
      )
      .run(valid.path, JSON.stringify(valid.value));
  }
  remove(target) {
    this.db.prepare("DELETE FROM openclaw_overrides WHERE path = ?").run(target);
  }
}
