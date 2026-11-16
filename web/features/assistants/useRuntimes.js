import { useCallback, useMemo } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { runtimeInfoOf, validRuntimes } from "./runtime-list.js";

/**
 * The runtime list (runtime-list.js), followed on the live topic `runtimes`: every
 * runtime with its traits, its install state and whether a new agent may run on it
 * now. `runtimes` is [] until the answer and after a failure, and `infoOf(id)` the
 * view of one (runtimeInfoOf). `loading` and `error` are the topic's; `written()`
 * follows a write that changes an install state and resolves once the change shows,
 * `refresh()` reads the list again (useLiveTopic). With `enabled` false nothing is
 * followed and the list stays [] (agents off: there is no list to read).
 */
export default function useRuntimes(enabled = true) {
  const { data, loading, error, refresh, written } = useLiveTopic(
    enabled ? "runtimes" : null,
  );
  const runtimes = useMemo(() => validRuntimes(data), [data]);
  const infoOf = useCallback((id) => runtimeInfoOf(runtimes, id), [runtimes]);
  return { runtimes, infoOf, loading, error, refresh, written };
}
