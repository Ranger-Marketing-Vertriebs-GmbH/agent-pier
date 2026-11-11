const guarded = new WeakSet();

/**
 * The one way to listen for upgrades on an HTTP server. Node hands an upgraded socket
 * over without any listener of its own, so until someone listens for `error`, a peer
 * that resets the connection (while a refusal is being written, during an
 * authorization, before `ws` has taken the socket) ends the process with an unhandled
 * `error` event. Every socket therefore gets its `error` listener here, before the
 * attacher runs; an error ends that one connection and is not logged.
 * `tests/unit/upgrade-entry-guard.test.js` fails for an upgrade listener attached elsewhere.
 * Returns a function that removes the listener.
 */
export function onUpgrade(server, listener) {
  const upgrade = (req, socket, head) => {
    if (!guarded.has(socket)) {
      guarded.add(socket);
      socket.on("error", () => socket.destroy());
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
