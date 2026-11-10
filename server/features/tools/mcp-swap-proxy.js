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
const isNotification = (msg) => typeof msg?.method === "string" && msg.id === undefined;
const isResponse = (msg) =>
  msg && typeof msg === "object" && msg.method === undefined && msg.id !== undefined;
const sameSpec = (a, b) =>
  a?.command === b?.command && JSON.stringify(a?.args) === JSON.stringify(b?.args);
const failure = (message) =>
  Object.assign(new Error(message), { code: "MCP_PROXY_SERVER_FAILED" });

/** One spawned server: its child, the generation it serves and its internal calls. */
class Server {
  constructor(proxy, spec, gen) {
    this.proxy = proxy;
    this.spec = spec;
    this.gen = gen;
    this.stopping = false;
    this.exited = false;
    this.internal = new Map();
    this.buffer = "";
    this.child = proxy.spawn(spec.command, spec.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: process.env,
    });
    this.done = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exited = true;
        for (const { reject } of this.internal.values())
          reject(failure(`exited (${signal ?? code})`));
        this.internal.clear();
        resolve();
        proxy.serverExited(this, code, signal);
      });
    });
    this.child.once("error", (error) => {
      // A command that cannot start: report it like an exit.
      if (!this.exited) {
        this.exited = true;
        for (const { reject } of this.internal.values()) reject(error);
        this.internal.clear();
        proxy.serverExited(this, null, null, error);
      }
    });
    this.child.stdin.on("error", () => {});
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) proxy.fromServer(this, line);
      }
    });
    this.child.stderr.on("data", (chunk) => proxy.log(chunk));
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
        reject(failure(`${method} timed out`));
      }, timeoutMs);
      this.internal.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, ...(params && { params }) });
    });
  }
  /** Ends the server and its process group (also what it forked). */
  async stop() {
    this.stopping = true;
    const pid = this.child.pid;
    try {
      this.child.stdin.end();
    } catch {}
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
    // A child forked at the moment of the kill may outlive it (macOS).
    await this.proxy.settle([pid]);
  }
}

/**
 * The swap proxy. `write(line)` sends to the client, `spawn` starts a server,
 * `report(status)` records the current state for AgentPier (`{ command, args,
 * error }`), `exit(code)` ends the proxy. The first `start(spec)` launches the server
 * the client initializes; `swapTo(spec)` replaces it once no call is in flight.
 */
export class SwapProxy {
  constructor({
    write,
    spawn = defaultSpawn,
    log = (chunk) => process.stderr.write(chunk),
    report = () => {},
    exit = (code) => process.exit(code),
    settle = (pids) => settleKilledGroups(pids),
    drainCapMs = 10 * 60 * 1000,
    startTimeoutMs = 30 * 1000,
    retryMs = 30 * 1000,
  }) {
    Object.assign(this, {
      write,
      spawn,
      log,
      report,
      exit,
      settle,
      drainCapMs,
      startTimeoutMs,
      retryMs,
    });
    this.current = null;
    this.gen = 0;
    this.nextId = 1;
    this.queue = [];
    this.holding = false;
    this.swapping = null;
    this.wanted = null;
    this.initParams = null;
    this.initialized = false;
    this.lastTools = null;
    // Client request id (key) → { server, method, cursor }.
    this.pending = new Map();
    // Proxy id of a server's request → { server, id }.
    this.serverRequests = new Map();
    this.restartedAt = 0;
    this.drained = null;
    this.closed = false;
  }
  start(spec) {
    this.current = new Server(this, spec, ++this.gen);
    this.report({ command: spec.command, args: spec.args ?? [], error: null });
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
    if (Array.isArray(msg)) return msg.forEach((item) => this.route(item));
    this.route(msg);
  }
  route(msg) {
    if (isResponse(msg)) return this.answerServer(msg);
    if (this.holding) return void this.queue.push(msg);
    this.deliver(msg);
  }
  deliver(msg) {
    const server = this.current;
    if (!server || server.exited) {
      if (isRequest(msg))
        this.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: "The MCP server is not running." },
        });
      return;
    }
    if (isRequest(msg)) {
      if (msg.method === "initialize") this.initParams = msg.params ?? {};
      this.pending.set(key(msg.id), {
        server,
        method: msg.method,
        cursor: msg.params?.cursor,
      });
    } else if (isNotification(msg)) {
      if (msg.method === "notifications/initialized") this.initialized = true;
      if (msg.method === "notifications/cancelled") {
        const entry = this.pending.get(key(msg.params?.requestId));
        if (entry && entry.server !== server) return entry.server.send(msg);
      }
    }
    server.send(msg);
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
        return msg.error
          ? own.reject(failure(msg.error.message))
          : own.resolve(msg.result);
      }
      const entry = this.pending.get(key(msg.id));
      // Answered already (failed after a crash) or another server's: never twice.
      if (!entry || entry.server !== server) return;
      this.pending.delete(key(msg.id));
      this.drainedCheck();
      if (entry.method === "initialize" && msg.result) msg = withListChanged(msg);
      if (entry.method === "tools/list" && !entry.cursor && msg.result)
        this.lastTools = JSON.stringify(msg.result.tools ?? []);
      return this.send(msg);
    }
    if (isRequest(msg)) {
      const id = `${proxyPrefix}s${server.gen}-${this.nextId++}`;
      this.serverRequests.set(key(id), { server, id: msg.id });
      return this.send({ ...msg, id });
    }
    // The proxy announces list changes itself after a swap.
    if (server !== this.current && msg.method === "notifications/tools/list_changed")
      return;
    this.send(msg);
  }
  inFlight(server) {
    for (const entry of this.pending.values()) if (entry.server === server) return true;
    return false;
  }
  drainedCheck() {
    if (this.drained && !this.inFlight(this.current)) this.drained();
  }
  /** Resolves once `server` has no client call in flight, or false after the cap. */
  drain(server) {
    if (!this.inFlight(server)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.drained = null;
        resolve(false);
      }, this.drainCapMs);
      this.drained = () => {
        clearTimeout(timer);
        this.drained = null;
        resolve(true);
      };
    });
  }
  /** Releases the client messages held during a swap or a restart, in order. */
  release() {
    this.holding = false;
    const queued = this.queue;
    this.queue = [];
    for (const msg of queued) this.deliver(msg);
  }
  /** Starts a server for `spec` and repeats the client's handshake with it. */
  async launch(spec) {
    const server = new Server(this, spec, ++this.gen);
    try {
      if (this.initParams) {
        await Promise.race([
          server.call("initialize", this.initParams, this.startTimeoutMs),
          server.done.then(() => {
            throw failure("exited during start");
          }),
        ]);
        if (this.initialized)
          server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      }
      return server;
    } catch (error) {
      await server.stop();
      throw error;
    }
  }
  /** The tools the client sees changed with `server`: unknown counts as changed. */
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
   * Replaces the server with one for `spec` (newest wins while a swap runs): holds new
   * client messages, waits until no call is in flight (at most the cap, else it tries
   * again later), starts the new server, repeats the handshake, sends the client
   * `tools/list_changed` when the tools differ and stops the old server. A server that
   * does not start leaves the old one running and is reported.
   */
  swapTo(spec) {
    this.wanted = spec;
    this.swapping ??= this.runSwaps().finally(() => {
      this.swapping = null;
    });
    return this.swapping;
  }
  async runSwaps() {
    while (this.wanted && !this.closed) {
      const spec = this.wanted;
      this.wanted = null;
      if (!this.current || sameSpec(spec, this.current.spec)) continue;
      await this.swapOnce(spec);
    }
  }
  async swapOnce(spec) {
    const old = this.current;
    this.holding = true;
    if (!(await this.drain(old))) {
      this.release();
      this.retry(spec);
      return;
    }
    let next;
    try {
      next = await this.launch(spec);
    } catch (error) {
      this.release();
      this.report({
        command: old.spec.command,
        args: old.spec.args ?? [],
        error: `${spec.command}: ${error.message}`,
      });
      this.log(`AgentPier could not switch the MCP server: ${error.message}\n`);
      return;
    }
    const changed = await this.toolsChanged(next);
    this.current = next;
    this.forget(old);
    this.release();
    if (changed)
      this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    this.report({ command: spec.command, args: spec.args ?? [], error: null });
    await old.stop();
  }
  retry(spec) {
    const timer = setTimeout(() => {
      if (!this.wanted) void this.swapTo(spec);
    }, this.retryMs);
    timer.unref?.();
  }
  /** Drops what only `server` could answer (its requests to the client). */
  forget(server) {
    for (const [id, asked] of this.serverRequests)
      if (asked.server === server) this.serverRequests.delete(id);
  }
  /**
   * A server ended. The current one ending unexpectedly fails the client's calls in
   * flight with a clear error and is restarted once (with the handshake); a second
   * crash soon after ends the proxy, so the client sees the server gone.
   */
  serverExited(server, code, signal, error) {
    if (server !== this.current || server.stopping || this.closed) return;
    for (const [id, entry] of this.pending)
      if (entry.server === server) {
        this.pending.delete(id);
        this.send({
          jsonrpc: "2.0",
          id: JSON.parse(id),
          error: {
            code: -32603,
            message:
              "The MCP server stopped unexpectedly; AgentPier restarted it. Retry the call.",
          },
        });
      }
    this.forget(server);
    this.drainedCheck();
    const reason = error?.message ?? signal ?? `exit ${code}`;
    this.log(`AgentPier's MCP proxy: the server stopped (${reason}).\n`);
    if (Date.now() - this.restartedAt < CRASH_WINDOW_MS) return this.close(1);
    this.restartedAt = Date.now();
    this.holding = true;
    this.launch(server.spec).then(
      (next) => {
        this.current = next;
        this.release();
      },
      (failed) => {
        this.log(`AgentPier's MCP proxy could not restart it: ${failed.message}\n`);
        this.close(1);
      },
    );
  }
  /** The client went away (or the server cannot run): stop the server and exit. */
  async close(code = 0) {
    if (this.closed) return;
    this.closed = true;
    await this.current?.stop();
    this.exit(code);
  }
}

/** The initialize answer, with `tools.listChanged` so the client follows swaps. */
function withListChanged(msg) {
  const capabilities = msg.result.capabilities ?? {};
  if (!capabilities.tools) return msg;
  return {
    ...msg,
    result: {
      ...msg.result,
      capabilities: {
        ...capabilities,
        tools: { ...capabilities.tools, listChanged: true },
      },
    },
  };
}
