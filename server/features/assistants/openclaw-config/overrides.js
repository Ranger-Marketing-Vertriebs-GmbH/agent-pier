import { isLockedPath } from "./locked-core.js";
import {
  advancedSetting,
  advancedSettings,
  advancedSettingsRuntime,
  validSettingValue,
} from "./advanced-settings.js";
import { assistantProblem } from "../assistant-validation.js";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);

// True when any object key at any depth could reach a prototype.
function hasForbiddenKey(value) {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some(
    (key) => forbidden.has(key) || hasForbiddenKey(value[key]),
  );
}

/**
 * Only an allow-listed path (advanced-settings.js) with a value its schema accepts is
 * an override; a path in the locked core never is, even if the list named one.
 */
export function validateOverride(target, value) {
  const setting = advancedSetting(String(target));
  if (
    !setting ||
    isLockedPath(setting.path) ||
    hasForbiddenKey(value) ||
    !validSettingValue(setting, value)
  )
    throw assistantProblem("invalid", 400);
  return { path: setting.path, value: structuredClone(value) };
}

function removePath(config, parts) {
  const parents = [config];
  for (const part of parts.slice(0, -1)) {
    const node = parents.at(-1)[part];
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    parents.push(node);
  }
  delete parents.at(-1)[parts.at(-1)];
  // Parents left empty by the removal go too, so an unset override leaves no trace.
  for (let i = parents.length - 1; i > 0; i--) {
    if (Object.keys(parents[i]).length) return;
    delete parents[i - 1][parts[i - 1]];
  }
}

/**
 * Allow-listed paths belong to the overrides alone: every one is removed from the
 * configuration first (OpenClaw writes none of them itself), so an override the
 * owner reset, or a value an earlier start or a live patch left behind, never
 * survives a start. Then the stored overrides are written.
 */
export function applyOverrides(config, overrides) {
  const result = structuredClone(config);
  for (const { path: target } of advancedSettings) removePath(result, target.split("."));
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

/**
 * The overrides a Gateway start of `version` compiles in. OpenClaw refuses unknown
 * keys, so they apply only to the runtime the allow list was qualified against; any
 * other version (a rollback) starts with OpenClaw's defaults and keeps them stored.
 */
export function overridesFor(store, version, { warn = console.warn } = {}) {
  const rows = store.list();
  if (!rows.length || !version || version === advancedSettingsRuntime) return rows;
  warn(
    `OpenClaw ${version} is not qualified for the advanced settings; ${rows.length} stored override(s) stay inactive.`,
  );
  return [];
}

/**
 * The owner's overrides. AgentPier is a single-owner installation: the table has no
 * owner column because one owner configures the one assistant Gateway.
 */
export class OverrideStore {
  // `onSkip(path)` reports a stored row that cannot be applied; never its value.
  constructor(db, { onSkip } = {}) {
    this.db = db;
    this.onSkip = onSkip;
  }
  // An invalid stored row (corrupt JSON, a path no longer allowed, or a value its
  // schema refuses) is skipped and reported, so it can never block a Gateway launch.
  list() {
    const rows = [];
    for (const row of this.db
      .prepare("SELECT path, value, revision FROM openclaw_overrides ORDER BY path")
      .all()) {
      try {
        const value = JSON.parse(row.value);
        validateOverride(row.path, value);
        rows.push({ path: row.path, value, revision: row.revision });
      } catch {
        this.onSkip?.(row.path);
      }
    }
    return rows;
  }
  get(target) {
    return this.list().find((row) => row.path === target) || null;
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
