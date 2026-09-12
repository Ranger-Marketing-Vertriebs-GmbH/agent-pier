import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { chatWindowPrefix } from "./chat-sync.js";
import { createChatStream } from "./chat-stream-transport.js";

export default function useChatStream({
  active,
  session,
  request,
  onConnection,
  output,
  stick,
}) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [restart, setRestart] = useState(0);
  const state = useRef({ live: null, older: [], cursor: null, paged: false, epoch: 0 });
  const loading = useRef(false);
  const anchor = useRef(null);
  const stop = useRef(null);
  const historyRequest = useRef(null);
  const publish = useCallback(() => {
    const current = state.current;
    const ids = new Set(current.live?.messages?.map((row) => row.id));
    setData(
      current.live && {
        ...current.live,
        messages: [
          ...current.older.filter((row) => !ids.has(row.id)),
          ...current.live.messages,
        ],
        history: { ...current.live.history, cursor: current.cursor },
      },
    );
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
      }
      const prefix = reset ? [] : chatWindowPrefix(current.live, next);
      if (prefix.length) {
        current.older = [
          ...new Map([...current.older, ...prefix].map((row) => [row.id, row])).values(),
        ];
      }
      current.live = next;
      if (!current.paged) current.cursor = next.history?.cursor || null;
      publish();
    },
    [publish],
  );
  useEffect(() => {
    state.current = {
      live: null,
      older: [],
      cursor: null,
      paged: false,
      epoch: state.current.epoch + 1,
    };
    loading.current = false;
    anchor.current = null;
    setData(null);
    setLoadError("");
    setHistoryLoading(false);
    setHistoryError("");
    stick.current = true;
  }, [session.id, stick]);
  useEffect(() => {
    if (!active) return;
    setHistoryLoading(false);
    const dispose = createChatStream({
      url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/sessions/${encodeURIComponent(session.id)}/chat-stream`,
      read: (signal) =>
        request(
          `/sessions/${encodeURIComponent(session.id)}/chat`,
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
    if (!active || loading.current || !current.cursor || !current.live) return;
    loading.current = true;
    setHistoryLoading(true);
    setHistoryError("");
    const epoch = current.epoch;
    const provider = current.live.providerSessionId;
    const cursor = current.cursor;
    const controller = new AbortController();
    historyRequest.current = controller;
    try {
      const page = await request(
        `/sessions/${encodeURIComponent(session.id)}/chat/history?cursor=${encodeURIComponent(cursor)}`,
        "GET",
        undefined,
        controller.signal,
      );
      if (state.current !== current || epoch !== current.epoch) return;
      if (page.providerSessionId !== provider || !Array.isArray(page.messages))
        throw new Error("Invalid history page");
      const element = output.current;
      if (element)
        anchor.current = { height: element.scrollHeight, top: element.scrollTop };
      const rows = new Map(
        [...page.messages, ...current.older].map((row) => [row.id, row]),
      );
      current.older = [...rows.values()];
      current.cursor = page.history?.cursor || null;
      current.paged = true;
      stick.current = false;
      publish();
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
    stop.current?.();
    state.current = {
      live: null,
      older: [],
      cursor: null,
      paged: false,
      epoch: state.current.epoch + 1,
    };
    accept(next);
    stick.current = true;
    setRestart((value) => value + 1);
  };
  return { data, loadError, historyError, historyLoading, loadOlder, choose };
}
