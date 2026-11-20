import { useWorkspaceStateCopy as copy } from "../lib/i18n/messages/app.js";
import { apiCopy } from "../lib/i18n/messages/components.js";
import { useState, useCallback, useEffect, useRef } from "react";
import { chatCacheKey, retainCachedChats } from "../features/chat/chat-session-cache.js";
import api from "../lib/api.js";
import useLiveTopic from "../lib/live/useLiveTopic.js";
import { workspaceStateView } from "./workspace-state-view.js";
import { createRefreshRetry } from "./refresh-retry.js";
import { readWorkspaceState, saveWorkspaceState } from "./workspace-state-cache.js";
import { useLocalizedNames } from "../lib/server-names.js";

const empty = {
  tools: [],
  utilities: [],
  accounts: [],
  sessions: [],
  home: "",
  remoteUrl: null,
};

/**
 * The workspace state from the live `state` topic (pushed rows, REST while the
 * channel falls back). `refresh()` reads GET /api/state for a caller that must see
 * a write it just made: it resolves with the data, rejects on failure, and its
 * answer shows until the topic pushes a state read later (workspace-state-view.js).
 */
export default function useWorkspaceState() {
  const live = useLiveTopic("state");
  const pushed = useRef(live.data);
  pushed.current = live.data;
  const connected = useRef(live.connected);
  connected.current = live.connected;
  // The last refresh, with the pushed value it started from. A failed one keeps the
  // answer before it, so the error never brings back an older state.
  const [read, setRead] = useState(null);
  const attempt = useCallback(async () => {
    const basis = pushed.current;
    try {
      const data = await api("/state", "GET");
      setRead({ basis, data, error: "" });
      return data;
    } catch (err) {
      setRead((last) => ({ basis, data: last?.data ?? null, error: err.message }));
      throw err;
    }
  }, []);
  // A failure while the channel is healthy retries with backoff (refresh-retry.js).
  const [retry] = useState(() =>
    createRefreshRetry({ attempt, healthy: () => connected.current }),
  );
  useEffect(() => () => retry.stop(), [retry]);
  // A push clears the error and ends the retries.
  useEffect(() => {
    retry.stop();
  }, [retry, live.data]);
  const refresh = useCallback(async () => {
    retry.stop();
    try {
      return await attempt();
    } catch (err) {
      retry.failed();
      throw err;
    }
  }, [attempt, retry]);
  const view = workspaceStateView(live, read);
  const { failure, loading } = view;
  const data = useLocalizedNames(view.data);
  useEffect(() => {
    if (Array.isArray(data?.sessions))
      retainCachedChats(new Set(data.sessions.map(chatCacheKey)));
  }, [data]);
  // The state kept on this device (workspace-state-cache.js): written at most once a
  // second after a change, shown while AgentPier cannot be read and nothing came yet.
  const [kept] = useState(readWorkspaceState);
  useEffect(() => {
    if (!data) return;
    const timer = setTimeout(() => saveWorkspaceState(data), 1000);
    return () => clearTimeout(timer);
  }, [data]);
  const shown = data || (failure ? kept : null);
  return {
    state: shown || empty,
    loading,
    // An unreachable AgentPier says so on its own (reach-server.js).
    error: !failure
      ? ""
      : failure === apiCopy.unreachable
        ? failure
        : copy.serviceConnectionError(failure),
    ready: Boolean(shown),
    refresh,
  };
}
