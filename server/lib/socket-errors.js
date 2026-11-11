const guarded = new WeakSet();
// How long a peer has to close its side after AgentPier ended its own.
const HALF_OPEN_GRACE_MS = 5000;

/**
 * The one way to listen for upgrades on an HTTP server. Node hands an upgraded socket
 * over without any listener of its own, so until someone listens for `error`, a peer
 * that resets the connection (while a refusal is being written, during an
 * authorization, before `ws` has taken the socket) ends the process with an unhandled
 * `error` event. Every socket therefore gets its `error` listener here, before the
 * attacher runs; an error ends that one connection and is not logged.
 * `tests/unit/upgrade-entry-guard.test.js` fails for an upgrade listener attached elsewhere.
 *
 * The same entry closes what a refusal leaves behind. An attacher refuses with
 * `socket.end(<HTTP answer>)`, which only ends AgentPier's side: an HTTP server's
 * sockets may stay half-open, and an upgraded socket has no timeout, so a peer that
 * never closes would keep the connection for good. Once the writable side has ended
 * (a refusal, the close of a WebSocket, the end of a proxied stream), the peer has
 * `graceMs` to close; then the socket is destroyed. The answer is already sent by
 * then. The first listener that sees a socket sets its grace.
 * Returns a function that removes the listener.
 */
export function onUpgrade(server, listener, { graceMs = HALF_OPEN_GRACE_MS } = {}) {
  const upgrade = (req, socket, head) => {
    if (!guarded.has(socket)) {
      guarded.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("finish", () => {
        if (socket.destroyed) return;
        const timer = setTimeout(() => socket.destroy(), graceMs);
        timer.unref();
        socket.once("close", () => clearTimeout(timer));
      });
    }
    return listener(req, socket, head);
  };
  server.on("upgrade", upgrade);
  return () => server.off("upgrade", upgrade);
}

/**
 * A listener that only finds out whether a port can be bound still accepts whoever
 * connects in that moment. Such a connection is closed at once, so it never stays
 * behind as a socket without an `error` listener.
 */
export const closeConnection = (socket) => socket.destroy();
