import { useCallback, useMemo, useState } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { userApi } from "./user-api.js";

/**
 * What waits for the user in her chats with one agent: the actions it asks her to
 * allow (/api/me/approvals lists only hers, pushed on her live topic `me.approvals`),
 * shown in each of those chats as the owner's chat shows his agent's. Read again after
 * each decision. Decides as AssistantActionApprovals expects.
 */
export default function useUserApprovals(assistantId) {
  const topic = useLiveTopic("me.approvals");
  const [error, setError] = useState("");
  const { refresh } = topic;
  const all = topic.data?.actions;
  // The chat keeps the last list while a read fails.
  const actions = useMemo(
    () =>
      (all || []).filter(
        (a) => a.assistantId === assistantId && a.state === "awaiting_approval",
      ),
    [all, assistantId],
  );
  const decide = useCallback(
    async (action, decision) => {
      setError("");
      try {
        await userApi.decide(action.id, { revision: action.revision, decision });
      } catch (e) {
        setError(e.message);
      }
      await refresh();
    },
    [refresh],
  );
  return { actions, error, decide };
}
