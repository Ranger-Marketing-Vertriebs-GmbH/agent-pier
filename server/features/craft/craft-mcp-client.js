import { execFile, spawn } from "node:child_process";

const PROTOCOL_VERSION = "2025-06-18";
const STDERR_LIMIT = 64 * 1024;
// close() must end well inside server/index.js's forced exit (6 s): every stop shares
// one budget, then the child gets a short grace before its groups are killed.
const STOP_BUDGET_MS = 2000;
const EXIT_GRACE_MS = 1000;
// Tools after which the builder may have started: the descendant snapshot is
// refreshed then, so an unexpected exit can still reach orphaned builders.
const SNAPSHOT_TOOLS = new Set(["rebuild_start", "rebuild_status"]);

const failure = (code, message, extra = {}) =>
  Object.assign(new Error(message), { code, ...extra });

const signalGroup = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
};

/** Every process as `{ pid, ppid, pgid }`; empty when ps cannot run. */
function processTable() {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-eo", "pid=,ppid=,pgid="],
      { timeout: 1000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve([]);
        resolve(
          stdout
            .split("\n")
            .map((line) => line.trim().split(/\s+/).map(Number))
            .filter((row) => row.length === 3 && row.every(Number.isInteger))
            .map(([pid, ppid, pgid]) => ({ pid, ppid, pgid })),
        );
      },
    );
  });
}

/**
 * The parsed payload of a tools/call result: `structuredContent`, else the JSON in
 * the first text block. Craft Anything wraps it as `{ result }` or `{ error }`.
 */
function toolPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object")
    return result.structuredContent;
  const text = result?.content?.find?.((block) => block?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/**
 * A client for `craft-anything-cli mcp`: newline-delimited JSON-RPC 2.0 over the
 * child's stdio. The child runs in its own process group; builds run in further
 * groups below it, which `close()` (and an unexpected exit) ends as well.
 */
export class CraftMcpClient {
  /**
   * Spawns the server, initializes it and checks that it offers `rebuild_start`.
   * `onSpawn(client)` hears the client as soon as the child runs, before initialize,
   * so a caller can close a child that never finishes it.
   */
  static async start({
    command,
    args = [],
    env,
    cwd,
    spawnImpl = spawn,
    timeoutMs,
    onSpawn,
  }) {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new CraftMcpClient(child);
    onSpawn?.(client);
    try {
      await client.initialize({ timeoutMs });
    } catch (failed) {
      await client.close();
      // A spawn failure (ENOENT, EACCES) is the cause, not the exit it led to.
      const error = client.spawnError ?? failed;
      if (client.stderr && !error.stderr) error.stderr = client.stderr;
      throw error;
    }
    return client;
  }

  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = "";
    this.stderrText = "";
    this.closing = false;
    this.exited = false;
    // pgid → pids seen in that group below the child; only these are ever killed.
    this.groups = new Map();
    this.ownGroup = null;
    this.exit = new Promise((resolve) => {
      const done = (code, signal) => {
        if (this.exited) return;
        this.exited = true;
        resolve();
        this.handleExit(code, signal);
      };
      child.once("exit", done);
      child.once("error", (error) => {
        this.spawnError = error;
        done(null, null);
      });
    });
    child.stdin?.on("error", () => {});
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => this.receive(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      this.stderrText = (this.stderrText + chunk).slice(-STDERR_LIMIT);
    });
  }

  get pid() {
    return this.child.pid;
  }

  /** The newest part of the server's stderr, for diagnostics. */
  get stderr() {
    return this.stderrText;
  }

  get alive() {
    return !this.exited && !this.closing;
  }

  /** `listener({ code, signal, expected, stderr })` once the child has exited. */
  onExit(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize({ timeoutMs = 30000 } = {}) {
    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agentpier", version: "1" },
      },
      timeoutMs,
    );
    this.notify("notifications/initialized");
    const names = new Set();
    let cursor;
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
      for (const tool of page?.tools ?? []) names.add(tool?.name);
      cursor = page?.nextCursor;
    } while (cursor);
    if (!names.has("rebuild_start"))
      throw failure(
        "CRAFT_MCP_NO_REBUILD",
        "Craft Anything does not offer rebuild_start; it needs --all-tools --allow-run.",
      );
    this.tools = names;
  }

  /** Calls tool `name`; resolves with its `result`, rejects with its error's code. */
  async call(name, args = {}, { timeoutMs = 30000 } = {}) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const payload = toolPayload(result);
    if (result?.isError || payload?.error) {
      const error = payload?.error ?? {};
      const message =
        (typeof error.message === "string" && error.message) ||
        payload?.text ||
        `Craft Anything tool ${name} failed.`;
      throw failure(
        typeof error.code === "string" || typeof error.code === "number"
          ? error.code
          : "CRAFT_MCP_TOOL_ERROR",
        message,
        { details: error },
      );
    }
    if (SNAPSHOT_TOOLS.has(name)) await this.snapshot();
    if (payload && "result" in payload) return payload.result;
    return payload;
  }

  /**
   * Shutdown order: `rebuild_stop` for every project at once (≤ 2 s in all) → close
   * stdin → wait up to 1 s → SIGKILL the child's group → SIGKILL every descendant
   * group recorded before. Ends within about 3 s even when no stop answers.
   */
  async close({ stopProjects = [] } = {}) {
    if (this.closed) return this.closed;
    this.closed = (async () => {
      const running = !this.exited;
      if (running)
        // All stops at once under one budget; the groups are recorded meanwhile.
        await Promise.all([
          ...stopProjects.map((project) =>
            this.call("rebuild_stop", { project }, { timeoutMs: STOP_BUDGET_MS }).catch(
              () => {},
            ),
          ),
          this.snapshot(),
        ]);
      this.closing = true;
      this.child.stdin?.end();
      let timer;
      await Promise.race([
        this.exit,
        new Promise((resolve) => (timer = setTimeout(resolve, EXIT_GRACE_MS))),
      ]);
      clearTimeout(timer);
      // The child leads its group; members can outlive the leader. A child that was
      // gone before close() is reached through the verified snapshot only.
      if (running && this.child.pid) signalGroup(this.child.pid, "SIGKILL");
      await this.killDescendants();
      this.rejectPending(failure("CRAFT_MCP_CLOSED", "Craft Anything was closed."));
    })();
    return this.closed;
  }

  /** Records the process groups of the child and its descendants (never ours). */
  async snapshot() {
    const root = this.child.pid;
    if (!root || this.exited) return;
    const table = await processTable();
    if (this.exited) return;
    const own = table.find((row) => row.pid === process.pid);
    if (own) this.ownGroup = own.pgid;
    const children = new Map();
    for (const row of table) {
      if (!children.has(row.ppid)) children.set(row.ppid, []);
      children.get(row.ppid).push(row);
    }
    // The child's own group is recorded too: its plain children stay in it.
    const queue = table.filter((row) => row.pid === root);
    while (queue.length) {
      const row = queue.shift();
      queue.push(...(children.get(row.pid) ?? []));
      if (!this.killable(row.pgid)) continue;
      if (!this.groups.has(row.pgid)) this.groups.set(row.pgid, new Set());
      this.groups.get(row.pgid).add(row.pid);
    }
  }

  killable(pgid) {
    return (
      Number.isInteger(pgid) && pgid > 1 && pgid !== this.ownGroup && pgid !== process.pid
    );
  }

  /**
   * SIGKILLs each recorded group that still holds a process we saw in it, so a
   * group number reused by an unrelated process is left alone.
   */
  async killDescendants() {
    if (!this.groups.size) return;
    const table = await processTable();
    for (const [pgid, pids] of this.groups) {
      const members = table.filter((row) => row.pgid === pgid);
      if (!members.length) {
        this.groups.delete(pgid);
        continue;
      }
      if (this.killable(pgid) && members.some((row) => pids.has(row.pid)))
        signalGroup(pgid, "SIGKILL");
      this.groups.delete(pgid);
    }
  }

  handleExit(code, signal) {
    const expected = this.closing;
    this.rejectPending(
      expected
        ? failure("CRAFT_MCP_CLOSED", "Craft Anything was closed.")
        : failure("CRAFT_MCP_EXITED", "Craft Anything exited unexpectedly.", {
            stderr: this.stderrText,
          }),
    );
    // Orphaned builders are reparented and no longer found below the child.
    if (!expected) this.killDescendants().catch(() => {});
    const event = { code, signal, expected, stderr: this.stderrText };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure must not keep the others from hearing the exit.
      }
    }
  }

  request(method, params, timeoutMs) {
    if (this.exited || this.closing)
      return Promise.reject(
        failure("CRAFT_MCP_CLOSED", "Craft Anything is not running."),
      );
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure("CRAFT_MCP_TIMEOUT", `Craft Anything did not answer ${method}.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, ...(params && { params }) });
  }

  send(message) {
    if (this.exited || !this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
    }
  }

  dispatch(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Not protocol output; stdout carries only JSON-RPC.
    }
    if (!message || typeof message !== "object") return;
    if (message.method) {
      // A request from the server (e.g. ping) gets an answer; notifications such
      // as notifications/progress are not needed here.
      if (message.id === undefined || message.id === null) return;
      if (message.method === "ping")
        return this.send({ jsonrpc: "2.0", id: message.id, result: {} });
      return this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error)
      pending.reject(
        failure(
          message.error.code ?? "CRAFT_MCP_ERROR",
          message.error.message || "Craft Anything answered with an error.",
          { details: message.error.data },
        ),
      );
    else pending.resolve(message.result);
  }

  rejectPending(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
  }
}
