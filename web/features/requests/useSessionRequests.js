import { useCallback, useSyncExternalStore } from "react";
import { sessionRequests } from "./session-requests-store.js";

const IDLE = Object.freeze({ data: null, error: "", loading: false });
const unsubscribed = () => {};

/**
 * A session's open native requests as `{ data, error, loading, update }`, shared
 * with every other view of the same session. `null` reads nothing.
 */
export default function useSessionRequests(sessionId, store = sessionRequests) {
  const subscribe = useCallback(
    (listener) => (sessionId ? store.subscribe(sessionId, listener) : unsubscribed),
    [sessionId, store],
  );
  const snapshot = useSyncExternalStore(subscribe, () =>
    sessionId ? store.get(sessionId) : IDLE,
  );
  const update = useCallback(
    (data) => {
      if (sessionId) store.update(sessionId, data);
    },
    [sessionId, store],
  );
  return {
    data: snapshot.data,
    error: snapshot.error,
    loading: snapshot.loading,
    update,
  };
}
