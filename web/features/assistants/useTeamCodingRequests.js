import { useCallback, useMemo } from "react";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import usePushedDecisions from "./usePushedDecisions.js";

// Coding requests of a parent's team members. They follow the live
// `agent.coding-requests:<id>` topic, which pushes every change. In the lead's chat,
// `pushed` is the pending list its live feed carries while connected
// (useAssistantActions); nothing is followed then.
export default function useTeamCodingRequests(assistantId, enabled, pushed = null) {
  const live = Array.isArray(pushed);
  const { hidden, hide } = usePushedDecisions(assistantId);
  const topic = useLiveTopic(
    enabled && !live && assistantId ? `agent.coding-requests:${assistantId}` : null,
  );
  const { refresh } = topic;
  // The fallback reads the whole action list: only team requests count.
  const loaded = useMemo(
    () => (topic.data?.actions || []).filter((a) => a.teamId),
    [topic.data],
  );
  const actions = useMemo(
    () => (live ? pushed.filter((a) => a.teamId) : loaded).filter((a) => !hidden(a)),
    [live, pushed, loaded, hidden],
  );
  const decide = useCallback(
    async (a, decision) => {
      await api(`/assistant-actions/${encodeURIComponent(a.id)}/decision`, "POST", {
        revision: a.revision,
        decision,
      });
      if (live) hide(a);
      else await refresh();
    },
    [refresh, live, hide],
  );
  return { actions, error: live ? "" : topic.error, decide };
}
