import { useCallback, useEffect, useState } from "react";
import api from "../../lib/api.js";
import usePolling from "./usePolling.js";
import { useAssistantEvent } from "./useAssistants.js";

// What waits for the owner in this agent's chat: its own coding tasks, memory changes
// and shell commands (team members included: a permanent member may have a shell),
// and its members' shell commands in turns it delegated (leadAssistantId). Loaded on
// change events and polled while one waits, because approvals expire. Team coding
// requests (teamId) belong to the lead's team card (useTeamCodingRequests).
export default function useAssistantActions(assistantId) {
  const [actions, setActions] = useState([]),
    [error, setError] = useState("");
  const lastEvent = useAssistantEvent();
  const load = useCallback(
    async (signal) => {
      try {
        const r = await api(`/assistants/${encodeURIComponent(assistantId)}/actions`);
        if (!signal?.aborted)
          setActions(
            (r.actions || []).filter((a) => a.state === "awaiting_approval" && !a.teamId),
          );
      } catch {
        // Settings report load failures; the chat keeps the last list.
      }
    },
    [assistantId],
  );
  useEffect(() => {
    if (!lastEvent || ["change", "connected"].includes(lastEvent.type)) load();
  }, [lastEvent, load]);
  usePolling(load, 5000, {
    enabled: actions.length > 0,
    immediate: false,
    restartKey: load,
  });
  const decide = useCallback(
    async (a, decision) => {
      setError("");
      try {
        await api(`/assistant-actions/${encodeURIComponent(a.id)}/decision`, "POST", {
          revision: a.revision,
          decision,
        });
        await load();
      } catch (e) {
        setError(e.message);
        // A decided or expired request (409) leaves the list instead of waiting for the poll.
        if (e.status === 409) await load();
      }
    },
    [load],
  );
  return { actions, error, decide, reload: load };
}
