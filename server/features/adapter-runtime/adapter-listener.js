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
 * supervisor accept some connections itself. While no adapter takes connections (restart
 * window, a child shutting down) they wait in a queue bounded in size (`maxQueued`) and
 * age (`maxAgeMs`; a paused socket never sees the client leave). After `refuse()` (give-up,
 * stop) connections get the optional static `response` and are closed, but the port stays
 * bound until `close()`.
 */
export async function createAdapterListener({ maxQueued = 64, maxAgeMs = 15_000 } = {}) {
  let target = null;
  let refusing = false;
  let response = null;
  const queue = new Map(); // socket → age timer, in arrival order
  const forward = (socket) => {
    try {
      target.send({ type: "connection" }, socket, (error) => {
        if (error) socket.destroy();
      });
    } catch {
      socket.destroy();
    }
  };
  const answer = (socket) => {
    if (!response) return void socket.destroy();
    // Drain the request so closing does not reset the connection before the client reads.
    socket.resume();
    socket.end(response);
    setTimeout(() => socket.destroy(), 1000).unref();
  };
  const dequeue = (socket) => {
    clearTimeout(queue.get(socket));
    queue.delete(socket);
    return socket;
  };
  const server = net.createServer({ pauseOnConnect: true }, (socket) => {
    socket.on("error", () => socket.destroy());
    if (refusing) answer(socket);
    else if (target) forward(socket);
    else if (queue.size < maxQueued) {
      const timer = setTimeout(() => dequeue(socket).destroy(), maxAgeMs);
      timer.unref();
      queue.set(socket, timer);
    } else socket.destroy();
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
    queued: () => queue.size,
    /** The adapter child that takes connections; null queues them (restart, shutdown). */
    setTarget(child) {
      target = refusing ? null : child;
      for (const socket of target ? [...queue.keys()] : []) forward(dequeue(socket));
    },
    /** Answers every waiting and later connection with `staticResponse` (or closes it). */
    refuse(staticResponse = null) {
      refusing = true;
      target = null;
      response ??= staticResponse;
      for (const socket of [...queue.keys()]) answer(dequeue(socket));
    },
    /**
     * Releases the port. It does not wait for the 'close' event: net.Server counts handed-over
     * connections and asks the (possibly dead) child when they are done, so the event can
     * stay pending forever. The listening socket itself is closed synchronously.
     */
    close() {
      response = null;
      this.refuse();
      if (server.listening) server.close();
    },
  };
}
