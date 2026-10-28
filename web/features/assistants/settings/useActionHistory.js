import { useCallback, useState } from "react";
import useLiveTopic from "../../../lib/live/useLiveTopic.js";
import { pendingCount } from "./agent-settings-fields.js";

// Every action of the agent (coding tasks, project memory changes), following the
// live `agent.actions:<id>` topic while the Overview tab is open. Without an id (a
// temporary member, which has no actions) nothing is followed.
export default function useActionHistory(assistantId) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const topic = useLiveTopic(assistantId ? `agent.actions:${assistantId}` : null);
  const { refresh } = topic;
  const act = useCallback(
    async (operation) => {
      setBusy(true);
      setError("");
      try {
        await operation();
        // An answer older than a push that arrived meanwhile is not shown.
        await refresh();
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  const list = topic.data?.actions || [];
  return {
    actions: list,
    loaded: topic.data !== null,
    pending: pendingCount(list),
    error: error || topic.error,
    busy,
    act,
  };
}
