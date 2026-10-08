import net from "node:net";
import { once } from "node:events";

/**
 * The supervisor's loopback listener for one adapter. The supervisor binds the port once
 * and keeps it for the whole session, so no other local process can take it while the
 * adapter restarts (it would receive the CLI's session token and prompts). Accepted
 * connections stay paused (nothing is read here) and are handed to the current adapter
 * child over IPC; the parent's copy is closed after the hand-over.
 *
 * A listening socket shared with the child would not do: the kernel would let the
 * supervisor accept some connections itself. While no adapter is ready (restart window)
 * connections wait in a bounded queue; after `refuse()` (give-up, stop) they are closed at
 * once, but the port stays bound until `close()`.
 */
export async function createAdapterListener({ maxQueued = 64 } = {}) {
  let target = null;
  let refusing = false;
  const queue = [];
  const forward = (socket) => {
    try {
      target.send({ type: "connection" }, socket, (error) => {
        if (error) socket.destroy();
      });
    } catch {
      socket.destroy();
    }
  };
  const server = net.createServer({ pauseOnConnect: true }, (socket) => {
    socket.on("error", () => socket.destroy());
    if (refusing) socket.destroy();
    else if (target) forward(socket);
    else if (queue.length < maxQueued) queue.push(socket);
    else socket.destroy();
  });
  // A failing accept must not take the launcher down.
  server.on("error", () => {});
  server.listen(0, "127.0.0.1");
  await Promise.race([
    once(server, "listening"),
    once(server, "error").then(([error]) => Promise.reject(error)),
  ]);
  return {
    port: server.address().port,
    /** The ready adapter child that receives connections; null during a restart. */
    setTarget(child) {
      target = refusing ? null : child;
      while (target && queue.length) forward(queue.shift());
    },
    refuse() {
      refusing = true;
      target = null;
      for (const socket of queue.splice(0)) socket.destroy();
    },
    /**
     * Releases the port. It does not wait for the 'close' event: net.Server counts handed-over
     * connections and asks the (possibly dead) child when they are done, so the event can
     * stay pending forever. The listening socket itself is closed synchronously.
     */
    close() {
      this.refuse();
      if (server.listening) server.close();
    },
  };
}
