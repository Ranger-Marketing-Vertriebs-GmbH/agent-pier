// Pure rules of the runtime list (GET /api/assistant-runtimes): every runtime a new
// agent may run on, each as an agent's `runtimeInfo` shows it (`{ id, name, version,
// capabilities }`, the traits beside each capability). No request here.

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
