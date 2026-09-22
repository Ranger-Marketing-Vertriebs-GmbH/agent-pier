import { applyChatSync } from "./chat-sync.js";

const CONNECT_TIMEOUT = 8000;
// An open socket may wait for a slow first server read; it is not a dead socket.
const FIRST_SNAPSHOT_TIMEOUT = 30000;

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
  // A running fallback survives reconnect attempts: a slow first snapshot must
  // land unless a socket snapshot, hiding, ending or disposal superseded it.
  const fallback = async () => {
    if (fallbacks >= 3 || fallbackController) return;
    fallbacks++;
    const version = revision;
    const controller = new AbortController();
    fallbackController = controller;
    const current = () => !disposed && !controller.signal.aborted && version === revision;
    try {
      const next = await read(controller.signal);
      if (!current()) return;
      snapshot = next;
      onSnapshot(next);
      onError("");
    } catch (error) {
      if (current()) onError(error.message);
    } finally {
      if (fallbackController === controller) fallbackController = null;
    }
  };
  const connect = () => {
    if (disposed || ended || visibility.hidden) return;
    onConnection("disconnected");
    cancel(timer);
    const token = ++epoch;
    let sequence = -1;
    const fail = (message = "") => {
      if (disposed || token !== epoch) return;
      // Detaching handlers also makes an error followed by close a single retry.
      stopSocket();
      onConnection("disconnected");
      if (message) onError(message);
      void fallback();
      timer = schedule(connect, Math.min(1000 * 2 ** attempt++, 15000));
    };
    try {
      socket = createSocket(url);
      deadline = schedule(() => fail(), CONNECT_TIMEOUT);
      socket.onopen = () => {
        if (disposed || token !== epoch) return;
        cancel(deadline);
        deadline = schedule(() => fail(), FIRST_SNAPSHOT_TIMEOUT);
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
    if (!ended) onConnection("disconnected");
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
