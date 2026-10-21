import { useCallback, useEffect, useState } from "react";
import { userApi } from "./user-api.js";

/**
 * What waits for the user in her chats with one agent: the actions it asks her to
 * allow (/api/me/approvals lists only hers), shown in each of those chats as the
 * owner's chat shows his agent's. Read at start, whenever her event stream reports a new
 * count, and after each decision. Decides as AssistantActionApprovals expects.
 */
export default function useUserApprovals(assistantId, subscribe) {
  const [actions, setActions] = useState([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await userApi.approvals();
      setActions(
        (result.actions || []).filter(
          (a) => a.assistantId === assistantId && a.state === "awaiting_approval",
        ),
      );
    } catch {
      // The chat keeps the last list; the next event reads it again.
    }
  }, [assistantId]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(
    () =>
      subscribe?.((event) => {
        if (["approvals", "connected"].includes(event.type)) load();
      }),
    [subscribe, load],
  );
  const decide = useCallback(
    async (action, decision) => {
      setError("");
      try {
        await userApi.decide(action.id, { revision: action.revision, decision });
      } catch (e) {
        setError(e.message);
      }
      await load();
    },
    [load],
  );
  return { actions, error, decide };
}
