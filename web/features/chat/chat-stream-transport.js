import { serverProblemText } from "../../lib/server-messages.js";
import { chatViewCopy as copy } from "../../lib/i18n/messages/chat.js";
import { applyChatSync, isChatSnapshot } from "./chat-sync.js";

const CONNECT_TIMEOUT = 8000;
// An open socket may wait for a slow first server read; it is not a dead socket.
const FIRST_SNAPSHOT_TIMEOUT = 30000;
// A never-settling HTTP read must not block later recovery reads.
const FALLBACK_TIMEOUT = 30000;

/**
 * One live subscription. HTTP is a bounded recovery path, never a polling loop.
 * `address(cursor)` builds the socket address (default: `url` with `?cursor=`).
 * Frames other than snapshots, syncs, errors and `ended` go to `onFrame`; it returns
 * false when the frame does not fit, which reconnects. `retryNow(code)` lets a close
 * code reconnect without backoff, and `network` (a window) reconnects when the
 * device comes back online. The returned dispose function has `refresh()`: one
 * HTTP read against the current cursor while no socket delivers.
 * `halt` ({codes, statuses}) opts into stopping for good: a close with one of
 * `codes` or a read failing with one of `statuses` (the login or the resource is
 * gone) ends all retries. Only an explicit trigger (the page becoming visible, the
 * device coming online, `refresh()`) tries again, with one HTTP read first; the
 * stream stays stopped while that read fails with one of `statuses`. With `halt`,
 * an error frame is only reported: the server closes the socket when it is fatal.
 */
export function createChatStream({
  url,
  address,
  read,
  onFrame,
  retryNow = () => false,
  network = null,
  halt = null,
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
    if (address) return address(value);
    return value ? `${url}?cursor=${encodeURIComponent(value)}` : url;
  };
  // Whether the current socket delivered its first frame.
  let live = false;
  // Stopped by `halt`: nothing reconnects until an explicit trigger.
  let halted = false;
  const halts = (error) => Boolean(halt?.statuses?.includes(error?.status));
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
  const fallback = async (forced = false) => {
    if ((!forced && fallbacks >= 3) || fallbackController) return;
    if (!forced) fallbacks++;
    const version = revision;
    const controller = new AbortController();
    fallbackController = controller;
    const current = () => !disposed && !controller.signal.aborted && version === revision;
    const limit = schedule(() => {
      if (fallbackController === controller) abortRead();
    }, FALLBACK_TIMEOUT);
    try {
      const response = await read(controller.signal, cursor());
      if (!current()) return false;
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
      return true;
      // The connection state stays with the socket: "connected" only follows an
      // accepted frame on an open socket, never an HTTP recovery read.
    } catch (error) {
      if (!current()) return false;
      onError(error.message);
      if (halts(error)) stop();
    } finally {
      cancel(limit);
      if (fallbackController === controller) fallbackController = null;
    }
  };
  const stop = () => {
    halted = true;
    ++epoch;
    cancel(timer);
    stopSocket();
    live = false;
    onConnection("disconnected");
  };
  const connect = () => {
    if (disposed || ended || halted || visibility.hidden) return;
    onConnection("disconnected");
    cancel(timer);
    const token = ++epoch;
    live = false;
    let sequence = -1;
    const fail = (message = "", code) => {
      if (disposed || token !== epoch) return;
      // Detaching handlers also makes an error followed by close a single retry.
      stopSocket();
      live = false;
      if (code !== undefined && halt?.codes?.includes(code)) {
        if (message) onError(message);
        return stop();
      }
      if (code !== undefined && retryNow(code)) attempt = 0;
      onConnection("disconnected");
      if (message) onError(message);
      void fallback();
      timer = schedule(connect, Math.min(1000 * 2 ** attempt++, 15000));
    };
    // The baseline whose cursor this socket's URL named. A fallback read may
    // replace `snapshot` before the socket's first frame, whose delta still
    // refers to this baseline.
    const opened = snapshot;
    // The first delta applies to the newest baseline, else to the one the socket
    // named; it is rejected only when it fits neither.
    const applyFrame = (data) => {
      if (sequence >= 0 || !opened || opened === snapshot)
        return applyChatSync(snapshot, data);
      try {
        return applyChatSync(snapshot, data);
      } catch (error) {
        if (data?.sync?.base !== opened.sync?.cursor) throw error;
        return applyChatSync(opened, data);
      }
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
          if (message.type === "error") {
            if (halt) return onError(serverProblemText(message, ""));
            return fail(serverProblemText(message, ""));
          }
          if (message.type !== "snapshot" && message.type !== "sync") {
            if (onFrame?.(message) === false) fail();
            return;
          }
          if (!Number.isInteger(message.sequence) || message.sequence <= sequence) return;
          if (sequence >= 0 && message.sequence !== sequence + 1) return fail();
          const next =
            message.type === "sync" ? applyFrame(message.data) : message.snapshot;
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
          if (sequence === first) {
            live = true;
            onConnection("connected");
          }
        } catch {
          // A rejected baseline must not seed the next connection.
          if (message?.type === "sync") snapshot = null;
          fail();
        }
      };
      socket.onerror = () => fail();
      socket.onclose = (event) => fail("", event?.code);
    } catch {
      fail();
    }
  };
  // An explicit trigger after a halt: one read decides whether to connect again.
  let resuming = null;
  const resume = () => {
    if (visibility.hidden || disposed) return Promise.resolve();
    resuming ??= (async () => {
      // A read failing with a halting status stops again (fallback).
      halted = false;
      try {
        await fallback(true);
      } finally {
        resuming = null;
      }
      if (halted || disposed || visibility.hidden) return;
      attempt = 0;
      connect();
    })();
    return resuming;
  };
  const visible = () => {
    if (halted) return void resume();
    if (!ended) onConnection("disconnected");
    ++epoch;
    abortRead();
    cancel(timer);
    stopSocket();
    if (!visibility.hidden) connect();
  };
  // Back online: a socket that died meanwhile reconnects now, not after its backoff.
  const online = () => {
    if (halted) return void resume();
    if (live) return;
    attempt = 0;
    visible();
  };
  visibility.addEventListener("visibilitychange", visible);
  network?.addEventListener("online", online);
  connect();
  const dispose = () => {
    disposed = true;
    ++epoch;
    abortRead();
    cancel(timer);
    stopSocket();
    visibility.removeEventListener("visibilitychange", visible);
    network?.removeEventListener("online", online);
  };
  dispose.refresh = () =>
    live || disposed ? Promise.resolve() : halted ? resume() : fallback(true);
  return dispose;
}
