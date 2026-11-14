import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import { once } from "node:events";
const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== "--socket" ||
  args[2] !== "--capability" ||
  !path.isAbsolute(args[1]) ||
  !path.isAbsolute(args[3])
)
  throw Error("Invalid session MCP arguments.");
let token;
try {
  const info = fs.lstatSync(args[3]);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw Error();
  token = JSON.parse(fs.readFileSync(args[3], "utf8")).token;
  if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{1,200}$/.test(token)) throw Error();
} catch {
  process.stderr.write("AgentPier session credential unavailable.\n");
  process.exit(1);
}
let protocol = "2025-03-26";
const parent = process.ppid;
const pending = new Set();
// Calls run side by side, so a waiting agent_ask holds back no other call; at most
// this many at once, the next ones wait in a queue (up to maxQueued, beyond that
// they are refused). stdin is read on meanwhile, so notifications/cancelled always
// arrives.
const maxCalls = 16;
const maxQueued = 256;
// The calls under way or queued by JSON-RPC id, for notifications/cancelled.
const calls = new Map();
const callKey = (id) => JSON.stringify(id);
// Above agent_ask's wait of about 110 s, like the CLIs' tool timeout (session-launch.js).
const requestTimeoutMs = 150000;
const watch = setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
}, 1000);
watch.unref();
function relay(message, call) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(message);
    const request = http.request(
      {
        socketPath: args[1],
        path: "/mcp",
        method: "POST",
        timeout: requestTimeoutMs,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": protocol,
        },
      },
      (response) => {
        response.setEncoding("utf8");
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
          if (Buffer.byteLength(text) > 524288)
            response.destroy(Error("Response too large"));
        });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode === 202 || response.statusCode === 204)
            return resolve(null);
          if (response.statusCode !== 200) return reject(Error("Access unavailable"));
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(Error("Invalid response"));
          }
        });
      },
    );
    if (call) call.request = request;
    pending.add(request);
    request.once("close", () => pending.delete(request));
    request.once("error", reject);
    request.once("timeout", () => request.destroy(Error("Request timed out")));
    request.end(body);
  });
}
// One JSON line per message, in a single write each, one after the other.
let writing = Promise.resolve();
function send(response) {
  writing = writing.then(async () => {
    if (!process.stdout.write(JSON.stringify(response) + "\n"))
      await once(process.stdout, "drain");
  });
  return writing;
}
/**
 * The client gave up on a call (user interrupt, its own timeout): closing its
 * upstream request ends the server's wait, so an agent_ask answer arrives later in
 * the session instead of in a response nobody reads. A cancelled call gets no reply.
 */
function cancel(message) {
  const call = calls.get(callKey(message.params?.requestId));
  if (!call) return;
  call.cancelled = true;
  call.request?.destroy();
}
function parse(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    throw Error("Invalid JSON");
  }
  if (
    !message ||
    Array.isArray(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  )
    throw Error("Invalid request");
  return message;
}
// Initialization runs before anything else: it sets the protocol version.
let initialized = Promise.resolve();
const failure = (id) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: {
    code: -32000,
    message:
      "AgentPier session access unavailable. Check the session grant and server; retry reads after a restart. Reuse requestId when retrying a start.",
  },
});
async function handle(message, call) {
  let response;
  try {
    if (message.method !== "initialize") await initialized.catch(() => {});
    for (let attempt = 0; ; attempt++) {
      if (call?.cancelled) return;
      try {
        response = await relay(message, call);
        break;
      } catch (error) {
        // A reload persists the new generation just after spawning the CLI.
        // Retry only initialization, never an operation with side effects.
        if (message.method !== "initialize" || attempt >= 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (message.method === "initialize" && response?.result?.protocolVersion)
      protocol = response.result.protocolVersion;
  } catch {
    response = failure(message.id);
  } finally {
    if (call && calls.get(callKey(message.id)) === call)
      calls.delete(callKey(message.id));
  }
  if (call && !call.cancelled && response) await send(response);
}
const running = new Set();
const queued = [];
function start({ message, call, done }) {
  const task = handle(message, call).catch(() => {});
  running.add(task);
  task.finally(() => {
    running.delete(task);
    done?.();
    if (queued.length && running.size < maxCalls) start(queued.shift());
  });
  return task;
}
async function dispatch(line) {
  const message = parse(line);
  // Only the bridge holds the upstream request; the stateless server has no use for it.
  if (message.method === "notifications/cancelled") return cancel(message);
  const call = message.id !== undefined ? { cancelled: false } : null;
  if (running.size < maxCalls) {
    if (call) calls.set(callKey(message.id), call);
    const task = start({ message, call });
    if (message.method === "initialize") initialized = task;
    return;
  }
  if (queued.length >= maxQueued) {
    if (call) await send(failure(message.id));
    return;
  }
  if (call) calls.set(callKey(message.id), call);
  let done;
  const finished = new Promise((resolve) => (done = resolve));
  if (message.method === "initialize") initialized = finished;
  queued.push({ message, call, done });
}
let buffer = "";
const decoder = new StringDecoder("utf8");
try {
  for await (const chunk of process.stdin) {
    buffer += decoder.write(chunk);
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 131072) throw Error();
      if (line.trim()) await dispatch(line);
    }
    if (Buffer.byteLength(buffer) > 131072) throw Error();
  }
  // Input ended: answer the calls still under way or queued before leaving.
  while (running.size) await Promise.allSettled([...running]);
} catch {
  process.stderr.write("AgentPier session transport closed.\n");
  process.exitCode = 1;
} finally {
  clearInterval(watch);
  for (const request of pending) request.destroy();
}
