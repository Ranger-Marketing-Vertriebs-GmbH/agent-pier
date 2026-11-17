// The surfaces of the agent runtimes (docs/adr/0007-runtime-descriptor.md): UI a
// runtime registers at a named slot of a page AgentPier owns. A runtime states them in
// its descriptor (runtimes/<id>/descriptor.js); the runtime list and an agent's
// `runtimeInfo` carry them. The web app renders a built surface with the component
// the runtime's web module registers under the same id
// (web/features/assistants/runtimes/<id>/index.js, RuntimeSlot.jsx) and a described
// one itself, from its fields.

/**
 * The slots, by the page that renders them. AgentPier owns the list; a slot is added
 * with the first surface that needs it.
 * - `hub.runtime`: a group of Agents › Runtime.
 * - `hub.runtime.advanced`: the runtime's own rows in Agents › Runtime › Advanced.
 * - `agent.capabilities`: groups at the end of an agent's Capabilities tab, for the
 *   agents of that runtime only, inside the tab's draft: the runtime's per-agent
 *   options (runtime-options.js), saved with the tab's PATCH.
 * - `agent.page`: a page of its own below an agent's Capabilities tab, for the agents
 *   of that runtime whose options switch it on (runtime-options.js `pages`; the
 *   agent's view names them as `runtimePages`); the surface's id is the page's.
 */
export const RUNTIME_SLOTS = Object.freeze([
  "hub.runtime",
  "hub.runtime.advanced",
  "agent.capabilities",
  "agent.page",
]);

// How a surface is made: `built` is a component of the runtime's web module;
// `described` a list of fields AgentPier renders, validates, stores and hands to the
// runtime's compiler (runtime-settings.js).
const SURFACE_KINDS = Object.freeze(["built", "described"]);

// When a surface shows: `whileEnabled` while a new agent may run on the runtime (the
// list entry's `ready`), the default; `always` also before, as the install group of
// an optional runtime must.
const SURFACE_SHOWS = Object.freeze(["whileEnabled", "always"]);

// Whose setting a described surface's fields are, and the slot that renders them:
// `host` is the runtime's advanced settings for all its agents.
const SCOPE_SLOTS = Object.freeze({ host: "hub.runtime.advanced" });

/** The types of a described field. */
export const FIELD_TYPES = Object.freeze(["toggle", "select", "number", "text"]);

/**
 * How a change of a described field reaches the runtime: `live` at once, `nextTurn`
 * with the next message, `restart` only after the runtime's host restarted, which the
 * owner confirms first.
 */
export const FIELD_APPLIES = Object.freeze(["live", "nextTurn", "restart"]);

const KEYS = Object.freeze(["id", "slot", "kind", "shows"]);
const DESCRIBED_KEYS = Object.freeze([...KEYS, "scope", "fields"]);
const FIELD_KEYS = Object.freeze([
  "id",
  "type",
  "options",
  "min",
  "max",
  "step",
  "unit",
  "default",
  "apply",
]);
// What only one field type states.
const TYPE_KEYS = Object.freeze({
  options: "select",
  min: "number",
  max: "number",
  step: "number",
  unit: "number",
});
const fieldId = /^[a-z][A-Za-z0-9]{0,39}$/;
// A text value is one line of at most this many characters.
const TEXT_LIMIT = 500;
const control = /[\u0000-\u001f\u007f]/;

// Whether `value` is `steps` whole steps above `base`, within floating point error.
function onStep(value, base, step) {
  const steps = (value - base) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

/**
 * True when `value` is one the described `field` accepts: a boolean for a toggle, one
 * of its options for a select, a finite number within its bounds and on its step for
 * a number, one line of text for a text. Only plain scalars ever are.
 */
export function validFieldValue(field, value) {
  if (field.type === "toggle") return typeof value === "boolean";
  if (field.type === "select")
    return typeof value === "string" && field.options.includes(value);
  if (field.type === "number")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (field.min === undefined || value >= field.min) &&
      (field.max === undefined || value <= field.max) &&
      (field.step === undefined || onStep(value, field.min ?? 0, field.step))
    );
  if (field.type === "text")
    return (
      typeof value === "string" && value.length <= TEXT_LIMIT && !control.test(value)
    );
  return false;
}

// One described field as stated, checked and frozen. `wrong(text)` makes the error.
function resolveField(stated, wrong) {
  const { id, type, options, min, max, step, unit, apply } = stated;
  const unknown = (what, value) => wrong(`${id}: unknown ${what} ${value}`);
  if (!FIELD_TYPES.includes(type)) throw unknown("type", JSON.stringify(type));
  const strange = Object.keys(stated).filter((key) => !FIELD_KEYS.includes(key));
  if (strange.length) throw unknown("key", strange.join(", "));
  for (const [key, only] of Object.entries(TYPE_KEYS))
    if (stated[key] !== undefined && type !== only)
      throw wrong(`${id}: ${key} on a ${type}`);
  if (
    type === "select" &&
    !(
      Array.isArray(options) &&
      options.length &&
      options.every((option) => typeof option === "string" && option) &&
      new Set(options).size === options.length
    )
  )
    throw wrong(`${id}: a select needs options, each a different text`);
  for (const [key, value] of Object.entries({ min, max, step }))
    if (value !== undefined && !Number.isFinite(value))
      throw wrong(`${id}: ${key} must be a number`);
  if (min !== undefined && max !== undefined && min > max)
    throw wrong(`${id}: min above max`);
  if (step !== undefined && step <= 0) throw wrong(`${id}: step must be above 0`);
  if (unit !== undefined && (typeof unit !== "string" || !unit))
    throw wrong(`${id}: unit must be a text`);
  if (!FIELD_APPLIES.includes(apply)) throw unknown("apply", JSON.stringify(apply));
  const field = Object.freeze({
    id,
    type,
    ...(options && { options: Object.freeze([...options]) }),
    ...(min !== undefined && { min }),
    ...(max !== undefined && { max }),
    ...(step !== undefined && { step }),
    ...(unit !== undefined && { unit }),
    default: stated.default,
    apply,
  });
  if (!validFieldValue(field, field.default))
    throw unknown("default", JSON.stringify(field.default));
  return field;
}

/**
 * The surfaces `stated` of runtime `runtime`, each with its `shows` rule,
 * deep-frozen: `[{ id, slot, kind, shows? }]`, and for a described one also `scope`
 * (`host`: the runtime's advanced settings for all its agents, at the slot
 * `hub.runtime.advanced`) and `fields`: `[{ id, type: "toggle" | "select" | "number"
 * | "text", options?, min?, max?, step?, unit?, default, apply: "live" | "nextTurn" |
 * "restart" }]`. A field's id is the runtime's: its stored value is kept under it
 * (runtime-settings.js), so no two fields of a runtime share one. A missing or
 * repeated id, a slot, kind, `shows`, scope, type or `apply` AgentPier does not name,
 * a select without options, bounds on anything but a number, a default the field
 * itself refuses and any further key throw a TypeError naming the runtime, the
 * surface and the field.
 */
export function resolveSurfaces(stated = [], runtime = "") {
  // Developer errors at module load; they never reach a browser.
  const wrong = (text) => new TypeError(`Runtime surface of ${runtime}: ${text}`);
  if (!Array.isArray(stated)) throw wrong("surfaces must be a list");
  const seen = new Set();
  const fieldsSeen = new Set();
  return Object.freeze(
    stated.map((surface) => {
      const { id, slot, kind, shows = SURFACE_SHOWS[0] } = surface || {};
      if (typeof id !== "string" || !id) throw wrong("a surface needs an id");
      if (seen.has(id)) throw wrong(`duplicate surface id ${id}`);
      seen.add(id);
      const within = (text) => wrong(`${id}: ${text}`);
      const unknown = (what, value) => within(`unknown ${what} ${value}`);
      if (!RUNTIME_SLOTS.includes(slot)) throw unknown("slot", JSON.stringify(slot));
      if (!SURFACE_KINDS.includes(kind)) throw unknown("kind", JSON.stringify(kind));
      if (!SURFACE_SHOWS.includes(shows)) throw unknown("shows", JSON.stringify(shows));
      const keys = kind === "described" ? DESCRIBED_KEYS : KEYS;
      const strange = Object.keys(surface).filter((key) => !keys.includes(key));
      if (strange.length) throw unknown("key", strange.join(", "));
      if (kind !== "described") return Object.freeze({ id, slot, kind, shows });
      const { scope, fields } = surface;
      if (!Object.hasOwn(SCOPE_SLOTS, scope ?? ""))
        throw unknown("scope", JSON.stringify(scope));
      if (slot !== SCOPE_SLOTS[scope])
        throw within(
          `described ${scope} fields belong to the slot "${SCOPE_SLOTS[scope]}"`,
        );
      if (!Array.isArray(fields) || !fields.length)
        throw within("a described surface needs fields");
      const resolved = fields.map((field) => {
        if (typeof field?.id !== "string" || !fieldId.test(field.id))
          throw within("a field needs an id of letters and digits");
        if (fieldsSeen.has(field.id)) throw within(`duplicate field id ${field.id}`);
        fieldsSeen.add(field.id);
        return resolveField(field, within);
      });
      return Object.freeze({
        id,
        slot,
        kind,
        shows,
        scope,
        fields: Object.freeze(resolved),
      });
    }),
  );
}
