import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "../../lib/api.js";
import usePolling from "./usePolling.js";
import { useAssistantEvents } from "./useAssistants.js";
import usePushedDecisions from "./usePushedDecisions.js";

// What waits for the owner in this agent's chat: its own coding tasks, memory changes,
// shell and SSH commands (team members included: a permanent member may have a shell),
// and its members' shell commands in turns it delegated (leadAssistantId). Team coding
// requests (teamId) belong to the lead's team card (useTeamCodingRequests).
const own = (a) =>
  !a.teamId &&
  (a.state === "awaiting_approval" ||
    // An allowed SSH command stays visible while it runs.
    (a.payload?.action === "ssh" && a.state === "executing"));

/**
 * `pushed` is the list the chat's live feed carries (useAgentConversationStream) while
 * its socket is connected, else null. Without it the list is read here: at start, on
 * change events and, because approvals expire, every 5 seconds while one waits.
 */
export default function useAssistantActions(assistantId, pushed = null) {
  const live = Array.isArray(pushed);
  const [loaded, setLoaded] = useState([]),
    [error, setError] = useState("");
  const { hidden, hide } = usePushedDecisions(assistantId);
  const liveRef = useRef(live);
  liveRef.current = live;
  const load = useCallback(
    async (signal) => {
      try {
        const r = await api(`/assistants/${encodeURIComponent(assistantId)}/actions`);
        if (!signal?.aborted) setLoaded((r.actions || []).filter(own));
      } catch {
        // Settings report load failures; the chat keeps the last list.
      }
    },
    [assistantId],
  );
  // Read at start and again whenever the feed stops carrying the list.
  useEffect(() => {
    if (!live) load();
  }, [load, live]);
  useAssistantEvents((event) => {
    if (!liveRef.current && ["change", "connected"].includes(event.type)) load();
  });
  const actions = useMemo(
    () => (live ? pushed.filter(own) : loaded).filter((a) => !hidden(a)),
    [live, pushed, loaded, hidden],
  );
  usePolling(load, 5000, {
    enabled: !live && actions.length > 0,
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
        // The feed pushes the decided action's new state; until then it stays hidden.
        if (liveRef.current) hide(a);
        else await load();
      } catch (e) {
        setError(e.message);
        // A decided or expired request (409) leaves the list instead of waiting for the poll.
        if (e.status === 409 && !liveRef.current) await load();
      }
    },
    [load, hide],
  );
  return { actions, error, decide, reload: load };
}
