// A browser-side stand-in for the agent chat feed
// (/api/assistant-conversations/:id/stream), for fixtures that route the agent API
// with Playwright. It never opens a real socket: every feed socket reads the routed
// history (`GET …/messages`) and pushes it as a full `sync` frame, like the server
// after a change. Pushes follow what moves the real feed:
// - a change or connected event a test hands agentEvent() below, and a `delta` event
//   becomes a whole `stream` frame of its conversation;
// - every non-GET request to a conversation or attempt (send, queue, stop, ...);
// - `window.agentFeed.push(id?)`, `.stream(id, runId, text, from)`, `.send(id, frame)`,
//   `.drop(id, code)`.
// `window.agentFeed.synced(id)` tells whether a socket of that chat delivered its
// first sync: a stream frame sent before it is cleared by that sync when no turn is
// open, as with the real feed.

import { liveStubOf } from "./live-stub.js";

// `base` is where the feed reads its chat: the user app reads /api/me/conversations.
function installFeed({ base = "/api/assistant-conversations" } = {}) {
  const Native = window.WebSocket;
  const pattern = /\/api\/assistant-conversations\/([^/?]+)\/stream(?:\?|$)/;
  const sockets = new Set();
  let opened = 0;
  class FeedSocket {
    constructor(url) {
      this.url = url;
      this.id = decodeURIComponent(url.match(pattern)[1]);
      this.cursor = new URL(url, location.href).searchParams.get("cursor");
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sequence = 0;
      opened++;
      sockets.add(this);
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({});
        void this.push();
      }, 0);
    }
    async push() {
      if (this.readyState !== 1) return;
      let data;
      try {
        const response = await fetch(`${base}/${encodeURIComponent(this.id)}/messages`);
        if (!response.ok) return;
        data = await response.json();
      } catch {
        return;
      }
      if (this.readyState !== 1) return;
      this.frame({
        type: "sync",
        sequence: ++this.sequence,
        data: {
          ...data,
          sync: { mode: "full", cursor: `fake-${opened}-${this.sequence}` },
        },
      });
    }
    frame(value) {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) });
    }
    close() {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      sockets.delete(this);
    }
    send() {}
  }
  window.WebSocket = new Proxy(Native, {
    construct: (target, args) =>
      pattern.test(String(args[0]))
        ? new FeedSocket(String(args[0]))
        : new target(...args),
  });
  const of = (id) => [...sockets].filter((socket) => !id || socket.id === id);
  window.agentFeed = {
    sockets,
    get opened() {
      return opened;
    },
    push: (id) => Promise.all(of(id).map((socket) => socket.push())),
    synced: (id) => of(id).some((socket) => socket.sequence > 0),
    // Any other frame, such as a running turn's `steps` (run-steps.js).
    send: (id, value) => of(id).forEach((socket) => socket.frame(value)),
    stream: (id, runId, text, from = 0) =>
      of(id).forEach((socket) => socket.frame({ type: "stream", runId, from, text })),
    drop: (id, code = 1006) =>
      of(id).forEach((socket) => {
        socket.readyState = 3;
        sockets.delete(socket);
        socket.onclose?.({ code });
      }),
    event(event) {
      if (["change", "connected"].includes(event?.type)) return this.push();
      if (event?.type === "delta")
        this.stream(event.conversationId, event.runId || "fixture-run", event.text);
    },
  };
  // A change the page makes is pushed back, as the server's change hint does.
  const nativeFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const method = String(args[1]?.method || args[0]?.method || "GET").toUpperCase();
    const url = String(args[0]?.url || args[0]);
    if (
      method !== "GET" &&
      /\/api\/(?:assistant-|me\/)(?:conversations|attempts)\//.test(url)
    )
      setTimeout(() => window.agentFeed.push(), 0);
    return response;
  };
}

/** Installs the fake feed before any page script runs. */
export const installAgentFeedFake = (page) => page.addInitScript(installFeed);

/** The same fake for the user app, whose chats read /api/me/conversations. */
export const installUserFeedFake = (page) =>
  page.addInitScript(installFeed, { base: "/api/me/conversations" });

/**
 * A server-side agent event in a spec: `change`, `connected` or `runtime` makes the
 * live stub read the agent list's routes again and push what changed (the server's
 * `agent.list` topic does so on every change), and the fake chat feeds read their
 * chats again; a `delta` streams into its conversation's feed.
 */
export async function agentEvent(page, event) {
  await page.evaluate((event) => window.agentFeed?.event(event), event);
  if (event?.type !== "delta") await liveStubOf(page)?.reread("agent.list");
}
