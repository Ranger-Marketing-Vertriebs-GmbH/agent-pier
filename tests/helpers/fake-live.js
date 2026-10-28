// A fake browser for LiveClient (web/lib/live/live-client.js): a WebSocket class that
// records every socket and what the client sent, a document whose `hidden` flag the
// test sets, a window for pagehide/pageshow/online, manual timers and a fixed random.
const settle = () => new Promise((resolve) => setImmediate(resolve));

export function fakeLive({ hidden = false, random = 0 } = {}) {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closedWith = undefined;
      this.answersPings = true;
      sockets.push(this);
    }
    send(text) {
      if (this.readyState !== 1) throw new Error("not open");
      const frame = JSON.parse(text);
      this.sent.push(frame);
      if (frame.op === "ping" && this.answersPings) this.receive({ type: "pong" });
    }
    close(code = 1000) {
      this.closedWith = code;
      this.readyState = 3;
    }
    /** The server side: open, then `hello`. */
    hello(instance = "i1") {
      this.readyState = 1;
      this.onopen?.({});
      this.receive({ type: "hello", instance });
    }
    receive(frame) {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
    /** The connection ends from the server or the network. */
    drop(code = 1006) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
  }
  const document = new EventTarget();
  document.hidden = hidden;
  const window = new EventTarget();
  let now = 0,
    sequence = 0;
  const timers = new Map();
  const env = {
    WebSocket: FakeSocket,
    url: "ws://test/api/live",
    document,
    window,
    random: () => random,
    now: () => now,
    setTimeout(callback, delay = 0) {
      const id = ++sequence;
      timers.set(id, { at: now + Math.max(0, delay), callback, id });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const due = (end) =>
    [...timers.values()]
      .filter((timer) => timer.at <= end)
      .sort((a, b) => a.at - b.at || a.id - b.id)[0];
  return {
    env,
    sockets,
    timers,
    last: () => sockets.at(-1),
    now: () => now,
    /** Milliseconds until the earliest pending timer, or null. */
    nextDelay() {
      const at = Math.min(...[...timers.values()].map((timer) => timer.at));
      return Number.isFinite(at) ? at - now : null;
    },
    setHidden(value) {
      document.hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    fire(name, fields = {}) {
      window.dispatchEvent(Object.assign(new Event(name), fields));
    },
    async advance(ms) {
      const end = now + ms;
      await settle();
      for (let next = due(end); next; next = due(end)) {
        timers.delete(next.id);
        now = next.at;
        next.callback();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

/** A whole `rows` frame payload as the server's ChatSync encodes it. */
export const rowsSnapshot = (sessions, cursor) => ({
  shape: { sessions: "array" },
  messages: sessions.map((session) => ({
    id: `sessions/${session.id}`,
    section: "sessions",
    value: session,
  })),
  sync: { mode: "full", cursor },
});
