import { isDeepStrictEqual } from "node:util";
import { assistantProblem } from "../assistant-validation.js";
import { RUNTIME_IDS, runtimeIdOf } from "./runtime-descriptors.js";
import { hermesDescriptor } from "./hermes/descriptor.js";
import { hermesOptions } from "./hermes/hermes-options.js";
import { openClawDescriptor } from "./openclaw/descriptor.js";
import { openClawOptions } from "./openclaw/openclaw-options.js";

// Per-agent options of one runtime (docs/adr/0007-runtime-descriptor.md, decision 9):
// the agent's profile holds `runtimeOptions: { [runtimeId]: object }`, and the
// runtime's own module says what its object may hold: `validate(value, context)` on
// a write (a translated refusal, or the stored form; `{}` stores nothing),
// `read(value, agent)` tolerantly on every read (what a later descriptor no longer
// names, or what the agent may no longer hold, is left out, never an error, so a
// rollback still starts the agent), optionally `pages(options)` (the agent's pages
// of the runtime's own the options switch on, slot `agent.page`) and
// `connections(options)`,
// the model connections the options name, which a live apply resolves. A runtime
// without options of its own takes none: any key is refused, nothing is read.
const modules = Object.freeze({
  [hermesDescriptor.id]: hermesOptions,
  [openClawDescriptor.id]: openClawOptions,
});
const none = Object.freeze({
  validate(value) {
    const key = Object.keys(value)[0];
    if (key !== undefined) throw assistantProblem("optionsUnknownKey", 400, key);
    return {};
  },
  read: () => ({}),
  connections: () => [],
});
const moduleOf = (id) => (Object.hasOwn(modules, id) ? modules[id] : none);
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const frozen = (value) => {
  for (const inner of Object.values(value))
    if (inner && typeof inner === "object") frozen(inner);
  return Object.freeze(value);
};

/**
 * The stored form of a write of `value` (the whole `runtimeOptions`) for `agent`
 * (its record before the write; at creation the input with its `runtime`): each
 * runtime id must be one this AgentPier ships and the agent's own (an option of a
 * runtime it does not run on could never apply), each object what that runtime
 * accepts. `context` goes to the runtime (`{ models }`, with `agent`). An object the
 * runtime stores as nothing leaves its id out; `{}` is "no options" (the store then
 * drops the field).
 */
export function validateRuntimeOptions(agent, value, context = {}) {
  if (!isRecord(value)) throw assistantProblem("optionsInvalid");
  const own = runtimeIdOf(agent);
  const result = {};
  for (const [id, options] of Object.entries(value)) {
    if (!RUNTIME_IDS.includes(id))
      throw assistantProblem("optionsUnknownRuntime", 400, id);
    if (id !== own) throw assistantProblem("optionsOtherRuntime", 400, id);
    if (!isRecord(options)) throw assistantProblem("optionsInvalid");
    const stored = moduleOf(id).validate(options, { ...context, agent });
    if (Object.keys(stored).length) result[id] = stored;
  }
  return result;
}

/**
 * The options of `agent` (a stored record) for the runtime it runs on, as that
 * runtime reads them: `{}` without any, frozen. Another runtime's stored options are
 * never read.
 */
export function runtimeOptionsOf(agent) {
  const id = runtimeIdOf(agent);
  const stored = isRecord(agent?.runtimeOptions) ? agent.runtimeOptions[id] : undefined;
  try {
    return frozen(structuredClone(moduleOf(id).read(stored, agent)));
  } catch {
    return Object.freeze({});
  }
}

/**
 * The ids of the runtime's own pages the agent's options switch on (slot
 * `agent.page`): `[]` without any.
 */
export const runtimePagesOf = (agent) => [
  ...(moduleOf(runtimeIdOf(agent)).pages?.(runtimeOptionsOf(agent)) || []),
];

/** The model connections `[{ connectionId, modelId }]` the agent's options name. */
export const optionConnections = (agent) =>
  moduleOf(runtimeIdOf(agent)).connections(runtimeOptionsOf(agent));

/**
 * `record` (a stored agent) with its options for its runtime as it may still hold
 * them: what `read` leaves out for the agent (an option it lost when it came to serve
 * users) is dropped from the stored record, and an emptied set with it. Another
 * runtime's stored options stay as they are.
 */
export function restrictRuntimeOptions(record) {
  const id = runtimeIdOf(record);
  if (!isRecord(record?.runtimeOptions) || !Object.hasOwn(record.runtimeOptions, id))
    return record;
  const kept = runtimeOptionsOf(record);
  if (isDeepStrictEqual(kept, record.runtimeOptions[id])) return record;
  const { [id]: _dropped, ...others } = record.runtimeOptions;
  const options = Object.keys(kept).length ? { ...others, [id]: { ...kept } } : others;
  const { runtimeOptions: _old, ...rest } = record;
  return Object.keys(options).length ? { ...rest, runtimeOptions: options } : rest;
}
