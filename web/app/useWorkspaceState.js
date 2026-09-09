import { useWorkspaceStateCopy as copy } from "../lib/i18n/messages/app.js";
import { useState, useCallback, useEffect } from "react";
import api from "../lib/api.js";
import { startVisiblePolling } from "../lib/visible-polling.js";
export default function useWorkspaceState() {
  const [state, setState] = useState({
    tools: [],
    utilities: [],
    accounts: [],
    sessions: [],
    home: "",
    remoteUrl: null,
  });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  const refresh = useCallback(async ({ signal } = {}) => {
    try {
      const data = await api("/state", "GET", undefined, signal);
      if (signal?.aborted) return;
      setState(data);
      setReady(true);
      setError("");
      setLoading(false);
      return data;
    } catch (err) {
      if (signal?.aborted) return;
      setError(copy.serviceConnectionError(err.message));
      setLoading(false);
      throw err;
    }
  }, []);
  useEffect(() => {
    return startVisiblePolling((signal) => refresh({ signal }), 3000);
  }, [refresh]);
  return {
    state,
    loading,
    error,
    ready,
    refresh,
  };
}
