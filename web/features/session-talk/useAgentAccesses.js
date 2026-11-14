import { useCallback } from "react";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";

const path = (sessionId) => `/sessions/${encodeURIComponent(sessionId)}/agent-accesses`;

/**
 * The agents one session may talk to: `{ agents, assignedIds, inheritedIds, tools }`,
 * followed over the live `session.agent-access:<sessionId>` topic (owner only), which
 * pushes every grant change and every change of the agents (one renamed, archived or
 * granted the session's project). `save(ids)` replaces the session's own grant and
 * resolves once the pushed value shows it.
 */
export default function useAgentAccesses(sessionId) {
  const topic = useLiveTopic(sessionId ? `session.agent-access:${sessionId}` : null);
  const { written } = topic;
  const save = useCallback(
    async (assistantIds) => {
      const result = await api(path(sessionId), "PUT", { assistantIds });
      await written();
      return result;
    },
    [sessionId, written],
  );
  return {
    data: topic.data,
    error: topic.error,
    loading: topic.loading,
    refresh: topic.refresh,
    save,
  };
}
