import { spawn as defaultSpawn } from "node:child_process";
import { settleKilledGroups } from "../craft/craft-mcp-client.js";

// The proxy between a coding CLI and a managed stdio MCP server (Craft Anything): it
// owns the client's connection and swaps the server behind it when AgentPier installs
// another version, without the session reloading. Messages are newline-delimited
// JSON-RPC, as MCP's stdio transport defines them.

const STOP_GRACE_MS = 1000;
// A crash within this time after a restart is not restarted again.
const CRASH_WINDOW_MS = 60 * 1000;
const proxyPrefix = "agentpier-proxy-";
const key = (id) => JSON.stringify(id);
const isRequest = (msg) => typeof msg?.method === "string" && msg.id !== undefined;
const isResponse = (msg) =>
  !!msg && typeof msg === "object" && msg.method === undefined && msg.id !== undefined;
const failure = (code, message) => Object.assign(new Error(message), { code });
const rpcError = (id, message) => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32603, message },
});
export const proxyErrors = Object.freeze({
  crashed: "The MCP server stopped unexpectedly; AgentPier restarted it. Retry the call.",
  replaced:
    "The MCP server was replaced by a newer version before it answered. Retry the call.",
  failed: "The MCP server stopped unexpectedly before it answered. Retry the call.",
  unavailable: "The MCP server is not running.",
});

/**
 * Splits a stream into lines. Each chunk is scanned once; the pieces of an unfinished
 * line wait in an array and are joined once, when its newline arrives.
 */
export function lineReader(onLine) {
  let pieces = [];
  return (chunk) => {
    let start = 0;
    let index;
    while ((index = chunk.indexOf("\n", start)) >= 0) {
      pieces.push(chunk.slice(start, index));
      const line = pieces.join("");
      pieces = [];
      start = index + 1;
      if (line.trim()) onLine(line);
    }
    if (start < chunk.length) pieces.push(chunk.slice(start));
  };
}

/** One spawned server: its child (own process group), its spec and its own calls. */
class Server {
  constructor(proxy, spec) {
    this.proxy = proxy;
    this.spec = spec;
    this.gen = ++proxy.gen;
    this.stopping = false;
    this.exited = false;
    this.internal = new Map();
    this.init = null;
    // Client notifications wait until the repeated handshake is done (launch()).
    this.ready = false;
    this.notes = [];
    this.child = proxy.spawn(spec.command, spec.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, ...spec.env },
    });
    let ended;
    this.done = new Promise((resolve) => (ended = resolve));
    const exited = (reason) => {
      if (this.exited) return;
      this.exited = true;
      for (const { reject } of this.internal.values())
        reject(failure("exited", `exited (${reason})`));
      this.internal.clear();
      ended();
      proxy.serverExited(this, reason);
    };
    this.child.once("exit", (code, signal) => exited(signal ?? code));
    this.child.once("error", (error) => exited(error.code ?? "error"));
    this.child.stdin.on("error", () => {});
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on(
      "data",
      lineReader((line) => proxy.fromServer(this, line)),
    );
    this.child.stderr.on("data", (chunk) => proxy.log(chunk));
  }
  /** A client notification: held until this server's handshake is done. */
  notify(msg) {
    if (this.ready) this.send(msg);
    else this.notes.push(msg);
  }
  /** The handshake is done: the held notifications follow, in order. */
  open() {
    this.ready = true;
    for (const msg of this.notes.splice(0)) this.send(msg);
  }
  send(msg) {
    if (this.exited) return;
    this.child.stdin.write(`${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
  }
  /** A request of the proxy itself; its answer never reaches the client. */
  call(method, params, timeoutMs) {
    const id = `${proxyPrefix}${this.gen}-${this.proxy.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.internal.delete(id);
        reject(failure("timeout", `${method} timed out`));
      }, timeoutMs);
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.internal.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.send({ jsonrpc: "2.0", id, method, ...(params && { params }) });
    });
  }
  /** Ends the server and its process group (also what it forked). */
  async stop() {
    this.stopping = true;
    try {
      this.child.stdin.end();
    } catch {}
    const pid = this.child.pid;
    if (!pid || this.exited) return;
    const signal = (name) => {
      try {
        process.kill(-pid, name);
      } catch {}
    };
    signal("SIGTERM");
    const timer = setTimeout(() => signal("SIGKILL"), STOP_GRACE_MS);
    await this.done;
    clearTimeout(timer);
    // A child forked at the moment of the kill may outlive it (macOS, #704).
    await this.proxy.settle([pid]);
  }
}

/**
 * The swap proxy. `write(line)` sends to the client, `readSpec()` reads the server
 * to run (`{ command, args, env }`, null when unreadable), `spawn` starts it,
 * `report(status)` records `{ command, error }` for AgentPier (`error` a stable code),
 * `exit(code)` ends the proxy. `start()` launches the server the client initializes;
 * `reconcile()` (after the spec changed) swaps to a server with another command.
 *
 * A swap starts the new server beside the old one and repeats the client's handshake;
 * then new requests go to the new server while the old one finishes the calls it has
 * (cancellations reach it), and stops once it has none. One task at a time: a crash
 * of the current server during a swap waits for that swap instead of restarting.
 */
export class SwapProxy {
  constructor({
    write,
    readSpec,
    spawn = defaultSpawn,
    log = (chunk) => process.stderr.write(chunk),
    report = () => {},
    exit = (code) => process.exit(code),
    settle = (pids) => settleKilledGroups(pids),
    drainCapMs = 10 * 60 * 1000,
    startTimeoutMs = 30 * 1000,
  }) {
    Object.assign(this, {
      write,
      readSpec,
      spawn,
      log,
      report,
      exit,
      settle,
      drainCapMs,
      startTimeoutMs,
    });
    this.servers = new Set();
    this.current = null;
    this.gen = 0;
    this.nextId = 1;
    this.queue = [];
    this.task = null;
    this.again = false;
    this.initParams = null;
    this.initialized = false;
    this.capabilities = null;
    this.lastTools = null;
    // Client request id (key) → { server, method, cursor }.
    this.pending = new Map();
    // Proxy id of a server's request (key) → { server, id }.
    this.serverRequests = new Map();
    this.restartedAt = 0;
    this.closed = false;
    this.fromClientLine = lineReader((line) => this.fromClient(line));
  }
  start() {
    const spec = this.readSpec();
    if (!spec) return this.close(1);
    this.current = this.add(new Server(this, spec));
    // The client's own initialize goes to this server first.
    this.current.open();
    this.report({ command: spec.command, error: null });
  }
  add(server) {
    this.servers.add(server);
    return server;
  }
  send(msg) {
    this.write(`${JSON.stringify(msg)}\n`);
  }
  /** A line from the client. */
  fromClient(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.current?.send(line);
    }
    for (const item of Array.isArray(msg) ? msg : [msg]) this.route(item);
  }
  route(msg) {
    if (isResponse(msg)) return this.answerServer(msg);
    if (msg?.method === "notifications/cancelled") {
      const owner = this.pending.get(key(msg.params?.requestId))?.server;
      if (owner) return owner.send(msg);
    }
    // Without a running server (a restart) the client waits for the next one.
    if (!this.current) return void this.queue.push(msg);
    this.deliver(msg);
  }
  deliver(msg) {
    const server = this.current;
    if (isRequest(msg)) {
      if (msg.method === "initialize") this.initParams = msg.params ?? {};
      this.pending.set(key(msg.id), {
        server,
        method: msg.method,
        cursor: msg.params?.cursor,
      });
      return server.send(msg);
    }
    if (msg?.method === "notifications/initialized") {
      this.initialized = true;
      return server.send(msg);
    }
    // Other notifications (roots changed, progress of the client) go to every server;
    // one still starting gets them after its handshake.
    for (const each of this.servers) each.notify(msg);
  }
  /** The client answers a server's request: back to the server that asked. */
  answerServer(msg) {
    const asked = this.serverRequests.get(key(msg.id));
    if (!asked) return;
    this.serverRequests.delete(key(msg.id));
    asked.server.send({ ...msg, id: asked.id });
  }
  /** A line from server `server`. */
  fromServer(server, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.log(`${line}\n`);
    }
    if (isResponse(msg)) {
      const own = server.internal.get(msg.id);
      if (own) {
        server.internal.delete(msg.id);
        if (msg.error) return own.reject(failure("refused", msg.error.message));
        return own.resolve(msg.result);
      }
      const entry = this.pending.get(key(msg.id));
      // Answered already (failed after a crash) or another server's: never twice.
      if (!entry || entry.server !== server) return;
      this.pending.delete(key(msg.id));
      if (entry.method === "initialize" && msg.result) {
        msg = withListChanged(msg);
        this.capabilities = msg.result.capabilities ?? {};
      }
      if (entry.method === "tools/list" && !entry.cursor && msg.result)
        this.lastTools = JSON.stringify(msg.result.tools ?? []);
      this.send(msg);
      return this.idleCheck(server);
    }
    if (isRequest(msg)) {
      const id = `${proxyPrefix}s${server.gen}-${this.nextId++}`;
      this.serverRequests.set(key(id), { server, id: msg.id });
      return this.send({ ...msg, id });
    }
    // The proxy announces list changes itself after a swap.
    if (server !== this.current && /\/list_changed$/.test(msg.method ?? "")) return;
    this.send(msg);
  }
  inFlight(server) {
    for (const entry of this.pending.values()) if (entry.server === server) return true;
    return false;
  }
  /** A retired server stops once its last call is answered. */
  idleCheck(server) {
    if (server.retired && !server.stopping && !this.inFlight(server)) void server.stop();
  }
  /** Fails the calls `server` still owes the client with `message`. */
  failCalls(server, message) {
    for (const [id, entry] of this.pending)
      if (entry.server === server) {
        this.pending.delete(id);
        this.send(rpcError(JSON.parse(id), message));
      }
    for (const [id, asked] of this.serverRequests)
      if (asked.server === server) this.serverRequests.delete(id);
  }
  /** The spec file changed: swap when it names another command. */
  reconcile() {
    if (this.closed) return Promise.resolve();
    if (this.task) {
      this.again = true;
      return this.task;
    }
    this.task = (async () => {
      do {
        this.again = false;
        await this.step();
      } while (this.again && !this.closed);
    })().finally(() => {
      this.task = null;
    });
    return this.task;
  }
  async step() {
    const spec = this.readSpec();
    const crashed = !this.current;
    if (crashed) {
      // A second crash soon after a restart: the client sees the server gone.
      if (!spec || Date.now() - this.restartedAt < CRASH_WINDOW_MS) return this.close(1);
      this.restartedAt = Date.now();
    } else if (!spec || spec.command === this.current.spec.command) return;
    let next;
    try {
      next = await this.launch(spec);
    } catch (error) {
      this.log(`AgentPier's MCP proxy could not start the server: ${error.message}\n`);
      if (crashed) return this.close(1);
      return this.report({ command: this.current.spec.command, error: "start-failed" });
    }
    const changed = await this.toolsChanged(next);
    if (this.closed) return next.stop();
    // A current server that crashed meanwhile is gone already (its calls failed).
    const old = this.current;
    this.current = next;
    const queued = this.queue;
    this.queue = [];
    for (const msg of queued) this.deliver(msg);
    this.announce(changed);
    const reported = () =>
      this.current && this.report({ command: this.current.spec.command, error: null });
    // The old server finishes its calls without holding up a restart or a next swap.
    if (old) void this.retire(old).then(reported);
    else reported();
  }
  /** Starts a server for `spec` and repeats the client's handshake with it. */
  async launch(spec) {
    const server = this.add(new Server(this, spec));
    try {
      if (this.initParams) {
        const exited = server.done.then(() => {
          throw failure("exited", "exited during start");
        });
        server.init = await Promise.race([
          server.call("initialize", this.initParams, this.startTimeoutMs),
          exited,
        ]);
        if (this.initialized)
          server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      }
      server.open();
      return server;
    } catch (error) {
      await server.stop();
      throw error;
    }
  }
  /** Whether the tools the client knows differ on `server` (unknown: changed). */
  async toolsChanged(server) {
    if (this.lastTools === null) return false;
    try {
      const result = await server.call("tools/list", undefined, this.startTimeoutMs);
      const tools = JSON.stringify(result?.tools ?? []);
      const changed = tools !== this.lastTools;
      this.lastTools = tools;
      return changed;
    } catch {
      return true;
    }
  }
  /**
   * Tells the client what may differ on the new server: the tools when they changed,
   * and the prompts and resources the client was told at its handshake (with
   * `listChanged`) that the server offers. The new server's own initialize answer
   * stays the proxy's: the client cannot take a second one.
   */
  announce(toolsChanged) {
    if (toolsChanged)
      this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    const offered = this.capabilities ?? {};
    for (const kind of ["prompts", "resources"])
      if (offered[kind])
        this.send({ jsonrpc: "2.0", method: `notifications/${kind}/list_changed` });
  }
  /** The old server finishes its calls (at most the cap), then stops. */
  async retire(old) {
    old.retired = true;
    if (this.inFlight(old)) {
      let timer;
      await Promise.race([
        old.done,
        new Promise((resolve) => (timer = setTimeout(resolve, this.drainCapMs))),
      ]);
      clearTimeout(timer);
      this.failCalls(old, proxyErrors.replaced);
    }
    await old.stop();
  }
  /**
   * A server ended. Its unanswered calls fail with a clear error. The current one
   * ending unexpectedly is restarted once (with the handshake) by the task, after a
   * swap that may be running; a second crash soon after ends the proxy.
   */
  serverExited(server, reason) {
    this.servers.delete(server);
    if (this.closed) return;
    const unexpected = !server.stopping;
    if (unexpected) this.log(`AgentPier's MCP proxy: the server stopped (${reason}).\n`);
    // Only the current server is restarted; a retired one's calls simply failed.
    const restarted = server === this.current && unexpected;
    this.failCalls(
      server,
      restarted
        ? proxyErrors.crashed
        : unexpected
          ? proxyErrors.failed
          : proxyErrors.replaced,
    );
    if (restarted) {
      this.current = null;
      void this.reconcile();
    }
  }
  /** The client went away (or the server cannot run): stop every server and exit. */
  async close(code = 0) {
    if (this.closed) return;
    this.closed = true;
    for (const msg of this.queue)
      if (isRequest(msg)) this.send(rpcError(msg.id, proxyErrors.unavailable));
    this.queue = [];
    await Promise.all([...this.servers].map((server) => server.stop()));
    this.exit(code);
  }
}

/** The initialize answer announcing list changes, so the client follows swaps. */
function withListChanged(msg) {
  const capabilities = { ...msg.result.capabilities };
  for (const kind of ["tools", "prompts", "resources"])
    if (capabilities[kind])
      capabilities[kind] = { ...capabilities[kind], listChanged: true };
  return { ...msg, result: { ...msg.result, capabilities } };
}
