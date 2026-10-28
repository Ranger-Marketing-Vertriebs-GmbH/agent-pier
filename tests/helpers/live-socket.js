import { WebSocket } from "ws";

/**
 * Opens the live channel of fixture `f` with `cookie` and records every frame.
 * `next(predicate)` resolves with the first recorded frame, earlier or later, that
 * matches and was not returned before; `closed` resolves with the close code.
 */
export function openLive(f, cookie = f.cookie, { origin = f.url } = {}) {
  const ws = new WebSocket(`${f.url.replace("http", "ws")}/api/live`, {
    headers: { cookie, origin },
  });
  const frames = [];
  const taken = new Set();
  const waiting = new Set();
  const settle = () => {
    for (const waiter of [...waiting]) {
      const frame = frames.find((item) => !taken.has(item) && waiter.predicate(item));
      if (!frame) continue;
      taken.add(frame);
      waiting.delete(waiter);
      waiter.resolve(frame);
    }
  };
  ws.on("message", (data) => {
    frames.push(JSON.parse(data.toString()));
    settle();
  });
  ws.on("error", () => {});
  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("unexpected-response", (_req, res) => {
      res.destroy();
      reject(Object.assign(new Error(`refused ${res.statusCode}`), res));
    });
  });
  opened.catch(() => {});
  const closed = new Promise((resolve) =>
    ws.once("close", (code) => {
      for (const waiter of waiting)
        waiter.reject(new Error(`closed with ${code} while waiting`));
      waiting.clear();
      resolve({ code });
    }),
  );
  return {
    ws,
    frames,
    opened,
    closed,
    send(op) {
      ws.send(typeof op === "string" ? op : JSON.stringify(op));
    },
    next(predicate = () => true, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(waiter);
          reject(new Error(`no matching frame in ${timeoutMs} ms`));
        }, timeoutMs);
        const waiter = {
          predicate,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        waiting.add(waiter);
        settle();
      });
    },
  };
}
