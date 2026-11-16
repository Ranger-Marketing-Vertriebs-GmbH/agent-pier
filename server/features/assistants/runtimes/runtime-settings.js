import { assistantProblem } from "../assistant-validation.js";
import { validFieldValue } from "./runtime-surfaces.js";

// A runtime's own advanced settings (docs/adr/0007-runtime-descriptor.md): the fields
// of the described surfaces its descriptor states with `scope: "host"`. AgentPier
// renders, validates and stores them; the runtime's compiler receives the values
// (ownSettings) and maps them into its own configuration. This module names no
// runtime. The shared advanced settings are AgentPier's and stay in their own store
// (shared-settings.js, openclaw/openclaw-config/overrides.js).

/**
 * The described advanced fields of the runtime `descriptor` states, each with the id
 * of its surface as `surface`, in descriptor order; [] without any.
 */
export const hostFields = (descriptor) =>
  (descriptor?.surfaces || [])
    .filter((surface) => surface.kind === "described" && surface.scope === "host")
    .flatMap((surface) =>
      surface.fields.map((field) => Object.freeze({ surface: surface.id, ...field })),
    );

const name = (value) => typeof value === "string" && !!value && value.length <= 64;
const scalar = (value) =>
  typeof value === "boolean" ||
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value));

/**
 * The owner's values of the runtimes' own advanced settings, by runtime id and field
 * id (table `runtime_settings`, beside the shared settings' `openclaw_overrides`,
 * which it never touches). It keeps plain scalars and knows no descriptor: what a
 * value means, and whether it still applies, is its reader's (ownSettings). An
 * AgentPier from before this table ignores it.
 */
export class RuntimeSettingStore {
  // `onSkip(runtime, field)` reports a stored row that cannot be read; never its value.
  constructor(db, { onSkip } = {}) {
    this.db = db;
    this.onSkip = onSkip;
  }
  /** The stored rows of `runtime`: `[{ field, value, revision }]`, by field id. */
  list(runtime) {
    const rows = [];
    for (const row of this.db
      .prepare(
        "SELECT field, value, revision FROM runtime_settings WHERE runtime = ? ORDER BY field",
      )
      .all(String(runtime))) {
      try {
        const value = JSON.parse(row.value);
        if (!scalar(value)) throw new TypeError("no scalar");
        rows.push({ field: row.field, value, revision: row.revision });
      } catch {
        this.onSkip?.(String(runtime), row.field);
      }
    }
    return rows;
  }
  get(runtime, field) {
    return this.list(runtime).find((row) => row.field === field) || null;
  }
  set(runtime, field, value) {
    if (!name(runtime) || !name(field) || !scalar(value))
      throw assistantProblem("invalid", 400);
    this.db
      .prepare(
        `INSERT INTO runtime_settings (runtime, field, value, revision) VALUES (?, ?, ?, 1)
         ON CONFLICT(runtime, field) DO UPDATE SET value = excluded.value, revision = revision + 1`,
      )
      .run(runtime, field, JSON.stringify(value));
  }
  remove(runtime, field) {
    this.db
      .prepare("DELETE FROM runtime_settings WHERE runtime = ? AND field = ?")
      .run(String(runtime), String(field));
  }
}

/**
 * The stored values of the runtime `descriptor` states, by field id, among those
 * `store` holds: only of a field the descriptor names today, and only a value that
 * field accepts. Anything else (a field a later version dropped, a value from before
 * a range changed) is left out, never an error. {} when the store cannot be read.
 */
export function storedSettings(descriptor, store) {
  const fields = new Map(hostFields(descriptor).map((field) => [field.id, field]));
  if (!fields.size) return {};
  let rows;
  try {
    rows = store.list(descriptor.id);
  } catch {
    return {};
  }
  return Object.fromEntries(
    rows
      .filter(({ field, value }) => {
        const described = fields.get(field);
        return !!described && validFieldValue(described, value);
      })
      .map(({ field, value }) => [field, value]),
  );
}

/**
 * What the compiler of the runtime `descriptor` states receives beside the desired
 * state: every described advanced field's value by field id, the owner's stored one
 * (storedSettings) or the field's default. Frozen; {} for a runtime without fields.
 */
export function ownSettings(descriptor, store) {
  const stored = storedSettings(descriptor, store);
  return Object.freeze(
    Object.fromEntries(
      hostFields(descriptor).map((field) => [
        field.id,
        Object.hasOwn(stored, field.id) ? stored[field.id] : field.default,
      ]),
    ),
  );
}
