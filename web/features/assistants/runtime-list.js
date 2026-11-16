// Pure rules of the runtime list (GET /api/assistant-runtimes, the live topic
// `runtimes`): every runtime this AgentPier ships, each as an agent's `runtimeInfo`
// shows it (`{ id, name, version, capabilities, surfaces }`, the traits beside each
// capability; runtime-surfaces.js reads the surfaces) with its install state
// (`install`: `{ kind: "builtin" }`, or `{ kind: "optional", enabled, installed, … }`)
// and `ready`: whether a new agent may run on it now. The first entry is the server's
// default. No request here.

/** The list in a server answer, or [] when it carries none. */
export const validRuntimes = (data) =>
  Array.isArray(data?.runtimes)
    ? data.runtimes.filter((r) => r && typeof r === "object" && typeof r.id === "string")
    : [];

/**
 * The view of runtime `id` in `runtimes`. No id ("" lets the server choose) is the
 * first entry, the server's default. Undefined while the list is empty or names no
 * such runtime: its traits are unknown then, and callers change nothing on them.
 */
export const runtimeInfoOf = (runtimes, id) =>
  Array.isArray(runtimes)
    ? id
      ? runtimes.find((runtime) => runtime.id === id)
      : runtimes[0]
    : undefined;

/**
 * The view of the runtime a wizard draft `d` runs on: the list's, else, for a
 * duplicate, its source's own view among `assistants` (the source runs on the same
 * runtime, and its view came with the agents list). So a duplicate knows how its
 * runtime behaves although the runtime list did not arrive.
 */
export const draftRuntimeInfo = (runtimes, d, assistants) =>
  runtimeInfoOf(runtimes, d?.runtime) ??
  (d?.duplicateOf
    ? assistants?.find((agent) => agent.id === d.duplicateOf)?.runtimeInfo
    : undefined);

/** The runtimes a new agent may run on now, in the list's order (the default first). */
export const readyRuntimes = (runtimes) =>
  Array.isArray(runtimes) ? runtimes.filter((runtime) => runtime.ready === true) : [];

/**
 * Whether a draft's runtime `id` is another one than the default: set, and not the
 * list's first entry. Without the list a named runtime counts as another one.
 */
export const otherRuntime = (runtimes, id) => Boolean(id) && id !== runtimes?.[0]?.id;

/** The name of a runtime from its view `info`; its `id` while the view is unknown. */
export const runtimeNameOf = (info, id) => info?.name || id || info?.id || "";

/**
 * The wizard's runtime group for draft `d`: `shown`, `readOnly` (a duplicate keeps
 * its source's runtime and only names it) and the `options` to choose from, the ready
 * runtimes: `{ id, value, name, checked }`, `value` "" for the default, which the
 * server chooses itself. A choice needs more than one ready runtime. A duplicate
 * shows the group once its source is chosen, also with a single ready runtime when
 * its own is another one than the default.
 */
export function runtimeChoice(runtimes, d) {
  const ready = readyRuntimes(runtimes);
  const duplicating = d.start === "duplicate";
  const hidden = { shown: false, readOnly: duplicating, options: [] };
  if (duplicating && !d.duplicateOf) return hidden;
  if (ready.length < 2 && !(duplicating && otherRuntime(runtimes, d.runtime)))
    return hidden;
  if (duplicating) return { shown: true, readOnly: true, options: [] };
  const defaultId = runtimes[0].id;
  const chosen = d.runtime || defaultId;
  return {
    shown: true,
    readOnly: false,
    options: ready.map(({ id, name }) => ({
      id,
      value: id === defaultId ? "" : id,
      name: name || id,
      checked: id === chosen,
    })),
  };
}
