import { useCallback, useMemo } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { runtimeInfoOf, validRuntimes } from "./runtime-list.js";

/**
 * The runtime list (runtime-list.js), followed on the live topic `runtimes`: every
 * runtime with its traits, its install state and whether a new agent may run on it
 * now. `runtimes` is [] until the answer and after a failure, and `infoOf(id)` the
 * view of one (runtimeInfoOf). `loading` and `error` are the topic's; `written()`
 * follows a write that changes an install state and resolves once the change shows,
 * `refresh()` reads the list again (useLiveTopic).
 */
export default function useRuntimes() {
  const { data, loading, error, refresh, written } = useLiveTopic("runtimes");
  const runtimes = useMemo(() => validRuntimes(data), [data]);
  const infoOf = useCallback((id) => runtimeInfoOf(runtimes, id), [runtimes]);
  return { runtimes, infoOf, loading, error, refresh, written };
}
