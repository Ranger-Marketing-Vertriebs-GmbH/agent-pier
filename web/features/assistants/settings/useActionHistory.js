import { useCallback, useState } from "react";
import api from "../../../lib/api.js";
import usePolling from "../usePolling.js";
import { pendingCount } from "./agent-settings-fields.js";

// Every action of the agent (coding tasks, project memory changes), polled while the
// Overview tab is open; slow responses never overlap (usePolling). Without an id
// (a temporary member, which has no actions) nothing is read.
export default function useActionHistory(assistantId) {
  const [actions, setActions] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const path = `/assistants/${encodeURIComponent(assistantId)}/actions`;
  usePolling(
    async (signal) => {
      try {
        const result = await api(path);
        if (!signal.aborted) setActions(result.actions || []);
      } catch (e) {
        if (!signal.aborted) setError(e.message);
      }
    },
    3000,
    { restartKey: assistantId, enabled: Boolean(assistantId) },
  );
  const act = useCallback(
    async (operation) => {
      setBusy(true);
      setError("");
      try {
        await operation();
        setActions((await api(path)).actions || []);
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    },
    [path],
  );
  const list = actions || [];
  return {
    actions: list,
    loaded: actions !== null,
    pending: pendingCount(list),
    error,
    busy,
    act,
  };
}
