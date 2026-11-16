import useRuntimes from "./useRuntimes.js";
import { hermesInstall } from "./hermes-runtime.js";

/**
 * The Hermes Agent runtime state: the optional runtime's install state in the runtime
 * list, pushed over the live topic `runtimes` (useRuntimes), so nothing is polled.
 * `missing` is true once the list is known and names no optional runtime, or cannot
 * be read (agents off). `written()` follows an action and resolves when its change
 * shows; `refresh()` reads the list again.
 */
export default function useHermesRuntime() {
  const { runtimes, loading, error, refresh, written } = useRuntimes();
  const state = hermesInstall(runtimes);
  return { state, missing: !state && !loading, error, refresh, written };
}
