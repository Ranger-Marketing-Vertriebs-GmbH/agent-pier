import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  assertChatSnapshot,
  chatWindowPrefix,
  prependHistoryRows,
  readOlderPage,
} from "./chat-sync.js";
import { createChatStream } from "./chat-stream-transport.js";
import {
  chatCacheKey,
  peekCachedChat,
  restoredSnapshot,
  writeCachedChat,
} from "./chat-session-cache.js";

const emptyState = (key, epoch = 0) => ({
  key,
  live: null,
  older: [],
  cursor: null,
  paged: false,
  epoch,
  restored: false,
  scroll: null,
});

// A cached chat seeds the first render; it stays `restored` until a frame is accepted.
function seededState(key) {
  const entry = peekCachedChat(key);
  if (!entry) return emptyState(key);
  return {
    ...emptyState(key),
    live: entry.live,
    older: Array.isArray(entry.older) ? entry.older : [],
    cursor: entry.cursor ?? null,
    paged: Boolean(entry.paged),
    restored: true,
    scroll: entry.scroll || null,
  };
}

function view(current) {
  if (!current.live) return null;
  const ids = new Set(current.live.messages.map((row) => row.id));
  const data = {
    ...current.live,
    clientObservedAt: current.observedAt,
    messages: [
      ...current.older.filter((row) => !ids.has(row.id)),
      ...current.live.messages,
    ],
    history: { ...current.live.history, cursor: current.cursor },
  };
  return current.restored ? restoredSnapshot(data) : data;
}

export default function useChatStream({
  active,
  session,
  request,
  onConnection,
  output,
  stick,
}) {
  const key = chatCacheKey(session);
  const state = useRef(null);
  if (state.current === null) state.current = seededState(key);
  // The saved scroll position waits for the first active layout of the seeded rows.
  const restoreScroll = useRef(state.current.scroll);
  // Set when the first frame replaced a restored window: the next commit must land
  // at the bottom even if a queued scroll event of the restore cleared `stick`.
  const followBottom = useRef(false);
  const [data, setData] = useState(() => view(state.current));
  const [loadError, setLoadError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [restart, setRestart] = useState(0);
  const loading = useRef(false);
  const anchor = useRef(null);
  const stop = useRef(null);
  const historyRequest = useRef(null);
  const publish = useCallback(() => setData(view(state.current)), []);
  const save = useCallback(() => {
    const { key: current, live, older, cursor, paged, scroll } = state.current;
    writeCachedChat(current, { live, older, cursor, paged, scroll: scroll || undefined });
  }, []);
  const accept = useCallback(
    (next) => {
      const current = state.current;
      const previousIds = new Set(current.live?.messages?.map((row) => row.id));
      const disjoint =
        previousIds.size > 0 &&
        next.messages.length > 0 &&
        !next.messages.some((row) => previousIds.has(row.id));
      const reset =
        disjoint ||
        current.live?.providerSessionId !== next.providerSessionId ||
        current.live?.history?.generation !== next.history?.generation ||
        !next.messages.length;
      const restored = current.restored;
      current.restored = false;
      if (reset) {
        historyRequest.current?.abort();
        historyRequest.current = null;
        current.epoch++;
        current.older = [];
        current.paged = false;
        loading.current = false;
        anchor.current = null;
        setHistoryLoading(false);
        setHistoryError("");
        if (restored) {
          // The cached position belongs to a window that no longer exists.
          restoreScroll.current = null;
          current.scroll = null;
          stick.current = true;
          followBottom.current = true;
        }
      }
      const prefix = reset ? [] : chatWindowPrefix(current.live, next);
      if (prefix.length) {
        current.older = [
          ...new Map([...current.older, ...prefix].map((row) => [row.id, row])).values(),
        ];
      }
      current.observedAt = Date.now();
      current.live = next;
      if (!current.paged) current.cursor = next.history?.cursor || null;
      publish();
      save();
    },
    [publish, save, stick],
  );
  useEffect(() => {
    // The mount already seeded this key; keep its rows and restored position.
    if (state.current.key === key) return;
    state.current = emptyState(key, state.current.epoch + 1);
    restoreScroll.current = null;
    loading.current = false;
    anchor.current = null;
    setData(null);
    setLoadError("");
    setHistoryLoading(false);
    setHistoryError("");
    stick.current = true;
  }, [key, stick]);
  useEffect(() => {
    if (!active) return;
    setHistoryLoading(false);
    const baseline = state.current.live;
    const dispose = createChatStream({
      // Re-creation continues from the accepted (or cached) cursor instead of full.
      initial: typeof baseline?.sync?.cursor === "string" ? baseline : undefined,
      url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/sessions/${encodeURIComponent(session.id)}/chat-stream`,
      read: (signal, cursor) =>
        request(
          `/sessions/${encodeURIComponent(session.id)}/chat${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          "GET",
          undefined,
          signal,
        ),
      onSnapshot: accept,
      onConnection: (status) => {
        if (status !== "connected" && state.current.live) {
          state.current.live = { ...state.current.live, nativeInput: null };
          publish();
        }
        onConnection?.(status);
      },
      onError: setLoadError,
    });
    stop.current = dispose;
    return () => {
      stop.current = null;
      historyRequest.current?.abort();
      historyRequest.current = null;
      state.current.epoch++;
      loading.current = false;
      dispose();
    };
  }, [
    active,
    session.id,
    session.status,
    session.restartGeneration,
    request,
    onConnection,
    accept,
    publish,
    restart,
  ]);
  const loadOlder = async () => {
    const current = state.current;
    if (
      !active ||
      current.restored ||
      loading.current ||
      !current.cursor ||
      !current.live
    )
      return;
    loading.current = true;
    setHistoryLoading(true);
    setHistoryError("");
    const epoch = current.epoch;
    const provider = current.live.providerSessionId;
    const cursor = current.cursor;
    const controller = new AbortController();
    historyRequest.current = controller;
    const shown = () =>
      new Set([
        ...current.older.map((row) => row.id),
        ...(current.live?.messages || []).map((row) => row.id),
      ]);
    try {
      const page = await readOlderPage({
        cursor,
        liveCursor: current.live.history?.cursor || null,
        known: shown(),
        read: (value) =>
          request(
            `/sessions/${encodeURIComponent(session.id)}/chat/history?cursor=${encodeURIComponent(value)}`,
            "GET",
            undefined,
            controller.signal,
          ),
      });
      if (state.current !== current || epoch !== current.epoch) return;
      if (page.providerSessionId !== provider || !Array.isArray(page.messages))
        throw new Error("Invalid history page");
      const element = output.current;
      if (element)
        anchor.current = { height: element.scrollHeight, top: element.scrollTop };
      // Rows that rolled out of the live window are already older than the page.
      current.older = prependHistoryRows(current.older, page.messages, shown());
      current.cursor = page.history?.cursor || null;
      current.paged = true;
      stick.current = false;
      publish();
      save();
    } catch (error) {
      if (state.current === current && epoch === current.epoch)
        setHistoryError(error.message);
    } finally {
      if (historyRequest.current === controller) historyRequest.current = null;
      if (state.current === current && epoch === current.epoch) {
        loading.current = false;
        setHistoryLoading(false);
      }
    }
  };
  useLayoutEffect(() => {
    const element = output.current;
    if (anchor.current && element) {
      element.scrollTop =
        anchor.current.top + element.scrollHeight - anchor.current.height;
      anchor.current = null;
    }
  }, [data, output]);
  const choose = (next) => {
    assertChatSnapshot(next);
    stop.current?.();
    state.current = emptyState(state.current.key, state.current.epoch + 1);
    restoreScroll.current = null;
    accept(next);
    stick.current = true;
    setRestart((value) => value + 1);
  };
  // Update-only: a scroll position never creates a cache entry.
  const saveScroll = useCallback((scroll) => {
    state.current.scroll = scroll;
    writeCachedChat(state.current.key, { scroll }, { create: false, flush: true });
  }, []);
  return {
    data,
    restored: Boolean(data?.restored),
    restoreScroll,
    followBottom,
    saveScroll,
    loadError,
    historyError,
    historyLoading,
    loadOlder,
    choose,
  };
}
