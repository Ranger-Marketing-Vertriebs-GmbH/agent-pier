import { applyChatSync } from "./chat-sync.js";

/** One live subscription. HTTP is a bounded recovery path, never a polling loop. */
export function createChatStream({
  url,
  read,
  onSnapshot,
  onConnection,
  onError,
  createSocket = (address) => new WebSocket(address),
  visibility = document,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let disposed = false;
  let ended = false;
  let socket;
  let timer;
  let deadline;
  let attempt = 0;
  let fallbacks = 0;
  let epoch = 0;
  let revision = 0;
  let snapshot = null;
  let fallbackController;
  const abortRead = () => {
    fallbackController?.abort();
    fallbackController = null;
  };
  const stopSocket = () => {
    cancel(deadline);
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
      socket = null;
    }
  };
  const fallback = async (token) => {
    if (fallbacks >= 3) return;
    fallbacks++;
    const version = revision;
    abortRead();
    const controller = new AbortController();
    fallbackController = controller;
    try {
      const next = await read(controller.signal);
      if (disposed || token !== epoch || version !== revision) return;
      snapshot = next;
      onSnapshot(next);
      onError("");
    } catch (error) {
      if (
        !disposed &&
        !controller.signal.aborted &&
        token === epoch &&
        version === revision
      )
        onError(error.message);
    }
  };
  const connect = () => {
    if (disposed || ended || visibility.hidden) return;
    cancel(timer);
    abortRead();
    const token = ++epoch;
    let sequence = -1;
    const fail = (message = "") => {
      if (disposed || token !== epoch) return;
      // Detaching handlers also makes an error followed by close a single retry.
      stopSocket();
      onConnection("disconnected");
      if (message) onError(message);
      void fallback(token);
      timer = schedule(connect, Math.min(1000 * 2 ** attempt++, 15000));
    };
    try {
      socket = createSocket(url);
      deadline = schedule(() => fail(), 8000);
      socket.onopen = () => {
        if (disposed || token !== epoch) return;
        onConnection("connected");
      };
      socket.onmessage = (event) => {
        if (disposed || token !== epoch) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "ended") {
            ended = true;
            ++epoch;
            stopSocket();
            abortRead();
            onConnection("ended");
            return;
          }
          if (message.type === "error") return fail(message.message);
          if (message.type !== "snapshot" && message.type !== "sync") return;
          if (!Number.isInteger(message.sequence) || message.sequence <= sequence) return;
          if (sequence >= 0 && message.sequence !== sequence + 1) return fail();
          const next =
            message.type === "sync"
              ? applyChatSync(snapshot, message.data)
              : message.snapshot;
          if (!next || !Array.isArray(next.messages)) throw new Error("Invalid snapshot");
          sequence = message.sequence;
          revision++;
          abortRead();
          snapshot = next;
          cancel(deadline);
          attempt = 0;
          fallbacks = 0;
          onSnapshot(next);
          onError("");
        } catch {
          fail();
        }
      };
      socket.onerror = () => fail();
      socket.onclose = () => fail();
    } catch {
      fail();
    }
  };
  const visible = () => {
    ++epoch;
    abortRead();
    cancel(timer);
    stopSocket();
    if (!visibility.hidden) connect();
  };
  visibility.addEventListener("visibilitychange", visible);
  connect();
  return () => {
    disposed = true;
    ++epoch;
    abortRead();
    cancel(timer);
    stopSocket();
    visibility.removeEventListener("visibilitychange", visible);
  };
}
