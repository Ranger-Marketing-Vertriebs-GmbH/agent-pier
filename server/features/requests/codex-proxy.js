import { WebSocketServer, WebSocket } from "ws";
import readline from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import { observeHookTrust } from "./codex-hook-trust.js";
import { codexRequest } from "./codex-protocol.js";

/** One real TUI connection and one stdio app-server. Both UIs race at this sole native owner. */
export async function createCodexProxy({ input, output, channel }) {
  const capability = randomBytes(32).toString("hex");
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: 16 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  let tui,
    closed = false;
  const hooks = observeHookTrust(channel);
  const requests = new Map();
  const retired = new Set();
  const idKey = (id) => JSON.stringify(id);
  function retire(identity, notify = true) {
    const entry = requests.get(identity);
    if (entry && notify) channel.resolve(entry.key);
    requests.delete(identity);
    retired.add(identity);
    // RPC ids should be unique, but a bounded tombstone also protects broken/native duplicate clients.
    if (retired.size > 10000) retired.delete(retired.values().next().value);
  }
  function write(message) {
    if (closed || output.destroyed || !output.writable)
      throw Error("Codex transport disconnected");
    output.write(JSON.stringify(message) + "\n");
  }
  server.on("connection", (socket, request) => {
    if (
      request.url !== "/" ||
      request.headers.authorization !== `Bearer ${capability}` ||
      tui
    ) {
      socket.close(1008);
      return;
    }
    tui = socket;
    socket.on("error", () => {});
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(String(data));
        if (message.id !== undefined && !message.method) {
          const identity = idKey(message.id);
          if (retired.has(identity)) return;
          if (requests.has(identity)) retire(identity);
        }
        try {
          hooks.outgoing(message);
        } catch {
          /* Future hook schemas remain native. */
        }
        write(message);
      } catch {
        socket.close(1003);
      }
    });
    socket.on("close", () => {
      hooks.close();
      for (const identity of requests.keys()) retire(identity);
      if (tui === socket) tui = null;
    });
  });
  const lines = readline.createInterface({ input });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (tui?.readyState === WebSocket.OPEN) {
        try {
          hooks.incoming(message);
        } catch {
          /* Never hide the native RPC response. */
        }
      }
      if (message.method === "serverRequest/resolved")
        retire(idKey(message.params?.requestId));
      if (["thread/closed", "thread/deleted"].includes(message.method))
        for (const [identity, entry] of requests)
          if (entry.threadId === message.params?.threadId) retire(identity);
      let adapter;
      try {
        adapter = codexRequest(message);
      } catch {
        /* Future native shapes stay fully available in Terminal. */
      }
      if (adapter && tui?.readyState === WebSocket.OPEN) {
        const identity = idKey(message.id);
        if (!requests.has(identity) && !retired.has(identity)) {
          const entry = { key: randomUUID(), threadId: message.params.threadId };
          requests.set(identity, entry);
          channel.publish(entry.key, adapter.view, async (answer) => {
            if (requests.get(identity) !== entry || tui?.readyState !== WebSocket.OPEN)
              throw Object.assign(Error("Codex request resolved"), { stale: true });
            if (answer.handoff) {
              channel.resolve(entry.key);
              return;
            }
            // Synchronous claim and write: a Terminal message cannot interleave between these steps.
            retire(identity, false);
            write(adapter.answer(answer));
          });
        }
      }
      if (tui?.readyState === WebSocket.OPEN) tui.send(line);
    } catch {
      /* Malformed/unknown output must never manufacture an actionable approval. */
    }
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    authToken: capability,
    async close() {
      if (closed) return;
      closed = true;
      hooks.close();
      for (const identity of requests.keys()) retire(identity);
      lines.close();
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
