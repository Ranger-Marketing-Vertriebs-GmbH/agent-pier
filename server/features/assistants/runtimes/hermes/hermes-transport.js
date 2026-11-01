import { createInterface } from "node:readline";

const closedError = () =>
  Object.assign(Error("The Hermes channel is closed."), {
    code: "UNAVAILABLE",
    status: 503,
  });

/**
 * The newline-delimited JSON-RPC channel to one Hermes agent over the stdin and
 * stdout of its RPC bridge process (hermes-rpc-bridge.py). It only frames: the
 * JSON-RPC client (requests, ids, server requests) is built on top of it.
 * - send(message): writes one frame (an object, or a JSON string without newlines);
 *   throws (code "UNAVAILABLE") once closed.
 * - onMessage(listener): `listener(frame)` for every parsed frame; returns unsubscribe.
 *   A line that is not JSON is dropped.
 * - onClose(listener): `listener()` once when the channel closes; returns unsubscribe.
 * - ready: resolves with Hermes's `gateway.ready` event frame (or never, if the
 *   channel closes first: `closedPromise` settles then).
 * - closed: whether the channel closed; close(): ends stdin, so the bridge exits.
 */
export function stdioTransport(child) {
  const messages = new Set();
  const closes = new Set();
  let closed = false;
  let announce;
  const ready = new Promise((resolve) => (announce = resolve));
  let finished;
  const closedPromise = new Promise((resolve) => (finished = resolve));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame?.method === "event" && frame.params?.type === "gateway.ready")
      announce(frame);
    for (const listener of [...messages]) listener(frame);
  });
  const close = () => {
    if (closed) return;
    closed = true;
    lines.close();
    finished();
    for (const listener of [...closes]) listener();
    closes.clear();
    messages.clear();
  };
  child.once("exit", close);
  child.stdin.on("error", close);
  return {
    get closed() {
      return closed;
    },
    ready,
    closedPromise,
    send(message) {
      if (closed || !child.stdin.writable) throw closedError();
      const text = typeof message === "string" ? message : JSON.stringify(message);
      if (/[\r\n]/.test(text)) throw new TypeError("A Hermes frame is one line.");
      return child.stdin.write(`${text}\n`);
    },
    onMessage(listener) {
      if (closed) return () => {};
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onClose(listener) {
      if (closed) {
        queueMicrotask(listener);
        return () => {};
      }
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close() {
      if (!closed) child.stdin.end();
    },
  };
}
