import { useCallback, useState } from "react";
import useAssistants from "./useAssistants.js";

// One owner action on a team at a time, with the shared list refreshed afterwards.
export default function useTeamActions() {
  const { refresh } = useAssistants();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const act = useCallback(
    async (operation) => {
      setBusy(true);
      setError("");
      try {
        await operation();
        await refresh();
      } catch (e) {
        setError(e.message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  return { busy, error, act };
}
