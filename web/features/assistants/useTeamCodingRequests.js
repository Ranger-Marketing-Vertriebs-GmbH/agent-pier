import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
import usePolling from "./usePolling.js";
const settled = new Set([
  "completed",
  "failed",
  "cancelled",
  "declined",
  "expired",
  "reviewed",
]);
// Coding requests of a parent's team members. Loaded once per assistant change
// event; polled only while one of them is still open.
export default function useTeamCodingRequests(assistantId, enabled, changes) {
  const [actions, setActions] = useState([]),
    [error, setError] = useState("");
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
            setActions((r.actions || []).filter((a) => a.teamId));
            setError("");
          }
        })
        .catch((e) => {
          if (alive.current) setError(e.message);
        }),
    [assistantId],
  );
  useEffect(() => {
    if (enabled) load();
  }, [enabled, load, changes]);
  const open = actions.some((a) => !settled.has(a.state));
  usePolling(load, 3000, {
    enabled: enabled && open,
    immediate: false,
    restartKey: load,
  });
  const decide = useCallback(
    async (a, decision) => {
      await api(`/assistant-actions/${encodeURIComponent(a.id)}/decision`, "POST", {
        revision: a.revision,
        decision,
      });
      await load();
    },
    [load],
  );
  return { actions, error, decide };
}
