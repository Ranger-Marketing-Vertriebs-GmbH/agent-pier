import { useCallback, useMemo, useRef, useState } from "react";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import usePushedDecisions from "./usePushedDecisions.js";

// What waits for the owner in this agent's chat: its own coding tasks, memory
// changes, shell and SSH commands and SFTP operations (team members included: a
// permanent member may have a shell), and its members' shell commands in turns it
// delegated (leadAssistantId). Team coding requests (teamId) belong to the lead's
// team card (useTeamCodingRequests).
const own = (a) =>
  !a.teamId &&
  (a.state === "awaiting_approval" ||
    // An allowed SSH command stays visible while it runs, and so does an allowed SFTP
    // card with its progress or an approved email while it is sent (a trusted job or
    // rule send shows no card).
    (a.state === "executing" &&
      (a.payload?.action === "ssh" ||
        (["sftp", "mail_send"].includes(a.payload?.action) &&
          a.payload.trusted === false))));

/**
 * `pushed` is the list the chat's live feed carries (useAgentConversationStream) while
 * its socket is connected, else null. Without it the list follows the live
 * `agent.actions:<id>` topic, which pushes every change (expiries included).
 */
export default function useAssistantActions(assistantId, pushed = null) {
  const live = Array.isArray(pushed);
  const [error, setError] = useState("");
  const { hidden, hide } = usePushedDecisions(assistantId);
  const liveRef = useRef(live);
  liveRef.current = live;
  const topic = useLiveTopic(
    !live && assistantId ? `agent.actions:${assistantId}` : null,
  );
  const { refresh } = topic;
  // Settings report load failures; the chat keeps the last list.
  const loaded = useMemo(() => (topic.data?.actions || []).filter(own), [topic.data]);
  const load = useCallback(() => refresh(), [refresh]);
  const actions = useMemo(
    () => (live ? pushed.filter(own) : loaded).filter((a) => !hidden(a)),
    [live, pushed, loaded, hidden],
  );
  const decide = useCallback(
    // `extra` carries the owner's edited rights of a hook proposal; the decided
    // action is returned (null when the decision failed).
    async (a, decision, extra = {}) => {
      setError("");
      try {
        const decided = await api(
          `/assistant-actions/${encodeURIComponent(a.id)}/decision`,
          "POST",
          { ...extra, revision: a.revision, decision },
        );
        // The feed pushes the decided action's new state; until then it stays hidden.
        if (liveRef.current) hide(a);
        else await load();
        return decided;
      } catch (e) {
        setError(e.message);
        // A decided or expired request (409) leaves the list at once.
        if (e.status === 409 && !liveRef.current) await load();
      }
      return null;
    },
    [load, hide],
  );
  return { actions, error, decide, reload: load };
}
