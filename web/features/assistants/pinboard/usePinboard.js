import { useCallback } from "react";
import useLiveTopic from "../../../lib/live/useLiveTopic.js";
import { pinboardApi } from "./pinboard-api.js";

/**
 * An agent's pinboard (`agent.pinboard:<agentId>` topic, the view route's answer):
 * `view` is `{ lists, fresh }` or null while loading. `markSeen` clears an entry's
 * NEW mark and resolves once the pushed view shows it.
 */
export default function usePinboard(assistantId) {
  const { data, error, loading, written } = useLiveTopic(
    assistantId ? `agent.pinboard:${assistantId}` : null,
  );
  const markSeen = useCallback(
    async (entryId) => {
      await pinboardApi.seen(assistantId, entryId);
      await written();
    },
    [assistantId, written],
  );
  return { view: data ?? null, loading, error, markSeen };
}
