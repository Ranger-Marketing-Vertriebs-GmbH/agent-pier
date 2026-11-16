import { WebSocketServer, WebSocket } from "ws";
import readline from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import { observeHookTrust } from "./codex-hook-trust.js";
import { codexRequest } from "./codex-protocol.js";
import { codexActivityTracker } from "./codex-activity.js";
import { codexReplyObserver } from "./codex-reply-stream.js";
import { codexPromptAcceptance } from "./codex-prompt-acceptance.js";
import { codexTaskTracker, NO_ANSWER } from "./codex-tasks.js";

// The only requests the proxy sends on its own (codex-tasks.js).
const OWN_METHODS = new Set([
  "turn/interrupt",
  "thread/backgroundTerminals/terminate",
  "thread/backgroundTerminals/list",
]);
const EXPERIMENTAL_REFUSED = "requires experimentalApi capability";

/**
 * One real TUI connection and one stdio app-server. Both UIs race at this sole native
 * owner. `request(method, params)` sends one of the proxy's own requests on the same
 * connection (`tasks` tracks what it may stop and reports it on `channel.tasks`).
 */
export async function createCodexProxy({
  input,
  output,
  channel,
  onActivity = () => {},
  // Streams agent message text to the chat (NativeRequestChannel); null: none.
  replies = channel,
}) {
  const activity = codexActivityTracker(onActivity);
  const reply = replies?.streamDelta ? codexReplyObserver(replies) : () => {};
  const capability = randomBytes(32).toString("hex");
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    // Codex's own app-server accepts 64 MiB; its TUI sends up to 32 MiB of base64
    // images in one turn/start. A lower limit closed the socket and lost the prompt.
    maxPayload: 64 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  let tui,
    closed = false;
  const hooks = observeHookTrust(channel);
  // Whether Codex took each prompt the TUI submits confirms chat deliveries.
  const prompts = codexPromptAcceptance((event) =>
    channel.prompt?.({ type: "prompt", ...event }),
  );
  const tasks = codexTaskTracker((state) => channel.tasks?.(state));
  // The proxy's own requests in flight by id, and whether Codex refused the terminal
  // methods on this connection. Their ids carry a per-launch nonce: the TUI uses
  // numbers and strings of its own ("initialize", UUIDs, "<name>-<uuid>") and cannot
  // know it, so every response with this prefix is the proxy's, in flight or not.
  const own = new Map();
  const ownPrefix = `agentpier:${randomBytes(8).toString("hex")}:`;
  const ownResponse = (message) =>
    !message.method && typeof message.id === "string" && message.id.startsWith(ownPrefix);
  let ownCount = 0,
    experimentalRefused = false;
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
  function settle(id, error, result) {
    const entry = own.get(id);
    if (!entry) return;
    own.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(result);
  }
  function answered(message) {
    const text = String(message.error?.message ?? "");
    if (message.error && text.includes(EXPERIMENTAL_REFUSED)) {
      experimentalRefused = true;
      tasks.setTerminalMethods(false);
    }
    if (message.error) settle(message.id, Error(text.slice(0, 500) || "Codex error"));
    else settle(message.id, null, message.result);
  }
  /** One of the proxy's own requests on the session's connection; resolves its result. */
  function request(method, params, { timeoutMs = 8000 } = {}) {
    if (!OWN_METHODS.has(method)) return Promise.reject(Error(`${method} not allowed`));
    const id = `${ownPrefix}${++ownCount}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => settle(id, Error(`${method}: ${NO_ANSWER}`)),
        timeoutMs,
      );
      timer.unref?.();
      own.set(id, { resolve, reject, timer });
      try {
        write({ id, method, params });
      } catch (error) {
        settle(id, error);
      }
    });
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
    channel.prompt?.({ type: "prompt-ready" });
    socket.on("error", () => {});
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(String(data));
        if (message.method === "initialize")
          tasks.setTerminalMethods(
            !experimentalRefused &&
              message.params?.capabilities?.experimentalApi === true,
          );
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
        try {
          prompts.outgoing(message);
        } catch {
          /* Observation only; the prompt still reaches Codex. */
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
      // A response to the proxy's own request is the proxy's alone, even a late one.
      if (ownResponse(message)) return void answered(message);
      if (message.id === undefined) {
        activity(message);
        reply(message);
        tasks(message);
      }
      try {
        prompts.incoming(message);
      } catch {
        /* Observation only; the TUI still gets every message. */
      }
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
    request,
    tracker: tasks,
    async close() {
      if (closed) return;
      closed = true;
      for (const id of [...own.keys()]) settle(id, Error("Codex transport disconnected"));
      hooks.close();
      for (const identity of requests.keys()) retire(identity);
      lines.close();
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
