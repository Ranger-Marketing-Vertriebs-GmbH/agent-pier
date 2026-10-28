import { useWorkspaceStateCopy as copy } from "../lib/i18n/messages/app.js";
import { useState, useCallback, useEffect, useRef } from "react";
import { chatCacheKey, retainCachedChats } from "../features/chat/chat-session-cache.js";
import api from "../lib/api.js";
import useLiveTopic from "../lib/live/useLiveTopic.js";

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
 * answer shows until the topic pushes something newer.
 */
export default function useWorkspaceState() {
  const live = useLiveTopic("state");
  const pushed = useRef(live.data);
  pushed.current = live.data;
  // The last refresh, with the pushed value it started from: a push after it wins.
  const [read, setRead] = useState(null);
  const refresh = useCallback(async () => {
    const basis = pushed.current;
    try {
      const data = await api("/state", "GET");
      setRead({ basis, data, error: "" });
      return data;
    } catch (err) {
      setRead({ basis, data: null, error: err.message });
      throw err;
    }
  }, []);
  const current = read && read.basis === live.data ? read : null;
  const data = current?.data || live.data || read?.data || null;
  const failure = current ? current.error : live.error;
  useEffect(() => {
    if (Array.isArray(data?.sessions))
      retainCachedChats(new Set(data.sessions.map(chatCacheKey)));
  }, [data]);
  return {
    state: data || empty,
    loading: !data && !failure && live.loading,
    error: failure ? copy.serviceConnectionError(failure) : "",
    ready: Boolean(data),
    refresh,
  };
}
