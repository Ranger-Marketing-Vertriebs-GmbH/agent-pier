import { serverProblemText } from "../../lib/server-messages.js";
import { chatViewCopy as copy } from "../../lib/i18n/messages/chat.js";
import { applyChatSync, isChatSnapshot } from "./chat-sync.js";

const CONNECT_TIMEOUT = 8000;
// An open socket may wait for a slow first server read; it is not a dead socket.
const FIRST_SNAPSHOT_TIMEOUT = 30000;
// A never-settling HTTP read must not block later recovery reads.
const FALLBACK_TIMEOUT = 30000;

/** One live subscription. HTTP is a bounded recovery path, never a polling loop. */
export function createChatStream({
  url,
  read,
  onSnapshot,
  onConnection,
  onError,
  initial,
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
  // A baseline without a cursor cannot seed a delta; treat it as absent.
  let snapshot =
    isChatSnapshot(initial) && typeof initial.sync?.cursor === "string" ? initial : null;
  const cursor = () => snapshot?.sync?.cursor;
  const socketUrl = () => {
    const value = cursor();
    return value ? `${url}?cursor=${encodeURIComponent(value)}` : url;
  };
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
    const limit = schedule(() => {
      if (fallbackController === controller) abortRead();
    }, FALLBACK_TIMEOUT);
    try {
      const response = await read(controller.signal, cursor());
      if (!current()) return;
      if (!response || typeof response !== "object") return onError(copy.invalidSnapshot);
      let next;
      try {
        next = applyChatSync(snapshot, response);
      } catch {
        // A rejected delta must not seed the next read; its raw text never reaches the UI.
        snapshot = null;
        return onError(copy.invalidSnapshot);
      }
      if (!isChatSnapshot(next)) return onError(copy.invalidSnapshot);
      snapshot = next;
      onSnapshot(next);
      onError("");
      // The connection state stays with the socket: "connected" only follows an
      // accepted frame on an open socket, never an HTTP recovery read.
    } catch (error) {
      if (current()) onError(error.message);
    } finally {
      cancel(limit);
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
      socket = createSocket(socketUrl());
      deadline = schedule(() => fail(), CONNECT_TIMEOUT);
      socket.onopen = () => {
        if (disposed || token !== epoch) return;
        cancel(deadline);
        deadline = schedule(() => fail(), FIRST_SNAPSHOT_TIMEOUT);
        onConnection("connecting");
      };
      socket.onmessage = (event) => {
        if (disposed || token !== epoch) return;
        let message;
        try {
          message = JSON.parse(event.data);
          if (message.type === "ended") {
            ended = true;
            ++epoch;
            stopSocket();
            abortRead();
            onConnection("ended");
            return;
          }
          if (message.type === "error") return fail(serverProblemText(message, ""));
          if (message.type !== "snapshot" && message.type !== "sync") return;
          if (!Number.isInteger(message.sequence) || message.sequence <= sequence) return;
          if (sequence >= 0 && message.sequence !== sequence + 1) return fail();
          const next =
            message.type === "sync"
              ? applyChatSync(snapshot, message.data)
              : message.snapshot;
          if (!isChatSnapshot(next)) throw new Error("Invalid snapshot");
          const first = sequence < 0 ? message.sequence : -1;
          sequence = message.sequence;
          revision++;
          abortRead();
          snapshot = next;
          cancel(deadline);
          attempt = 0;
          fallbacks = 0;
          onSnapshot(next);
          onError("");
          if (sequence === first) onConnection("connected");
        } catch {
          // A rejected baseline must not seed the next connection.
          if (message?.type === "sync") snapshot = null;
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
