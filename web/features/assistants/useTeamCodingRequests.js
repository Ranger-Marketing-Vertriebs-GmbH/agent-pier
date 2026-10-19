import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "../../lib/api.js";
import usePolling from "./usePolling.js";
import usePushedDecisions from "./usePushedDecisions.js";
const settled = new Set([
  "completed",
  "failed",
  "cancelled",
  "declined",
  "expired",
  "reviewed",
]);
// Coding requests of a parent's team members. Loaded once per assistant change
// event; polled only while one of them is still open. In the lead's chat, `pushed`
// is the pending list its live feed carries while connected (useAssistantActions);
// nothing is read then.
export default function useTeamCodingRequests(
  assistantId,
  enabled,
  changes,
  pushed = null,
) {
  const live = Array.isArray(pushed);
  const [loaded, setLoaded] = useState([]),
    [error, setError] = useState("");
  const { hidden, hide } = usePushedDecisions(assistantId);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = useCallback(
    () =>
      api(`/assistants/${encodeURIComponent(assistantId)}/actions`)
        .then((r) => {
          if (alive.current) {
            setLoaded((r.actions || []).filter((a) => a.teamId));
            setError("");
          }
        })
        .catch((e) => {
          if (alive.current) setError(e.message);
        }),
    [assistantId],
  );
  useEffect(() => {
    if (enabled && !live) load();
  }, [enabled, live, load, changes]);
  const actions = useMemo(
    () => (live ? pushed.filter((a) => a.teamId) : loaded).filter((a) => !hidden(a)),
    [live, pushed, loaded, hidden],
  );
  const open = actions.some((a) => !settled.has(a.state));
  usePolling(load, 3000, {
    enabled: enabled && open && !live,
    immediate: false,
    restartKey: load,
  });
  const decide = useCallback(
    async (a, decision) => {
      await api(`/assistant-actions/${encodeURIComponent(a.id)}/decision`, "POST", {
        revision: a.revision,
        decision,
      });
      if (live) hide(a);
      else await load();
    },
    [load, live, hide],
  );
  return { actions, error: live ? "" : error, decide };
}
