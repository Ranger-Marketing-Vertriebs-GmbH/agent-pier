// The `agentpier-bridge` Claude Code mod (hooks module, Claude Code 2.1.287 or newer).
// AgentPier copies this file into a per-launch plugin folder and loads it with
// `--plugin-dir`; it runs inside Claude Code's mod runtime (no Node, no DOM): every
// outside effect goes through `$`. It reports the session's turns, token-level reply
// text, tool calls, subagents and compactions to AgentPier over the request broker's
// private Unix socket (server/features/claude-mod/claude-mod-socket.js).
//
// It never changes what Claude Code does: every hook passes the event on unchanged,
// chunks are forwarded the moment they arrive, and reports are buffered and sent
// about every 100 ms, one request at a time, never awaited by a hook. Without
// AgentPier's launch environment (a remote or headless run, a plain `claude`) it
// stays quiet. It never logs anything.

const protocol = 1;
const flushMs = 100;
const maxText = 64 * 1024;
const maxQueue = 512;
const url = "http://agentpier/claude-mod/v1/events";
// Reports that must survive a failed request; the others describe a moment.
const kept = new Set(["hello", "turn.start", "turn.complete", "session.end"]);

const quietly = (fn) => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

/** AgentPier's launch environment; null when this is no AgentPier launch. */
export async function launchConfig(values) {
  try {
    const [socketPath, file, token] = await values;
    const session = /\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\.launch\.json$/.exec(
      file || "",
    )?.[1];
    if (
      typeof socketPath !== "string" ||
      !socketPath.startsWith("/") ||
      socketPath.length > 100 ||
      !session ||
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      return null;
    return { socketPath, session, token };
  } catch {
    return null;
  }
}

/** The state one loaded copy of the module keeps; a reload starts it over. */
// The runtime's `$` is spelled at each call site and never handed around, so the
// hooks give the bridge closures over their own `$` (`io`): read the environment,
// start a timer, send a request.
export class Bridge {
  constructor() {
    this.io = null;
    this.config = null;
    this.disabled = false;
    this.queue = [];
    this.timer = null;
    this.inflight = false;
    this.failures = 0;
    this.turn = null;
    this.agents = new Map();
  }
  use(io) {
    this.io = io;
    this.config ??= launchConfig(io.env());
    return this;
  }
  push(event) {
    if (this.disabled) return;
    this.queue.push(event);
    // A flood of reports while AgentPier is away keeps the newest and what matters.
    if (this.queue.length > maxQueue)
      this.queue = this.queue.filter(
        (item, index) => item.run || kept.has(item.type) || index > maxQueue / 2,
      );
    this.schedule();
  }
  hello(version) {
    this.push({ type: "hello", protocol, ...(version ? { cli: version } : {}) });
  }
  turnStart({ turnId, agentId }) {
    if (agentId !== undefined) return this.agentStart(agentId);
    this.turn = { id: turnId, order: 0, runs: new Map(), thinking: -1 };
    this.push({ type: "turn.start", turn: turnId });
  }
  /** One model request: a chunk observer for the main loop, null for a subagent's. */
  step({ turnId, index, agentId }) {
    if (agentId !== undefined || this.disabled) return null;
    // A reloaded copy hears the rest of a turn whose start it missed.
    if (this.turn?.id !== turnId)
      this.turn = { id: turnId, order: 0, runs: new Map(), thinking: -1 };
    const turn = this.turn;
    return (chunk) => {
      if (chunk?.kind === "text" && typeof chunk.text === "string" && chunk.text)
        this.text(turn, index, chunk.index, chunk.text);
      else if (
        chunk?.kind === "thinking" &&
        turn.thinking !== `${index}:${chunk.index}`
      ) {
        // Thinking is shown as a state only; its text never leaves Claude Code.
        turn.thinking = `${index}:${chunk.index}`;
        this.push({ type: "phase", turn: turn.id, phase: "thinking" });
      } else if (chunk?.kind === "stop") this.flushSoon();
    };
  }
  text(turn, step, block, text) {
    const key = `${step}:${block}`;
    let run = turn.runs.get(key);
    if (!run) {
      run = { turn: turn.id, step, block, order: turn.order++, text: "", sent: 0 };
      turn.runs.set(key, run);
    }
    if (run.text.length >= maxText) return;
    run.text += text.slice(0, maxText - run.text.length);
    if (this.queue.at(-1)?.run !== run) this.push({ run });
    else this.schedule();
  }
  turnComplete({ turnId, agentId, isAborted, durationMs, usage }) {
    if (agentId !== undefined) return this.agentEnd(agentId);
    this.push({
      type: "turn.complete",
      turn: turnId,
      aborted: isAborted === true,
      ...(Number.isFinite(durationMs) ? { durationMs: Math.round(durationMs) } : {}),
      ...(usage && Number.isFinite(usage.output_tokens)
        ? {
            usage: {
              input: Math.round(usage.input_tokens) || 0,
              output: Math.round(usage.output_tokens),
            },
          }
        : {}),
    });
    if (this.turn?.id === turnId) this.turn = null;
    this.flushSoon();
  }
  toolStart({ tool, tool_use_id: id, agentId }) {
    if (agentId !== undefined || typeof id !== "string") return false;
    this.push({ type: "tool.start", id, name: String(tool) });
    return true;
  }
  toolEnd(id) {
    this.push({ type: "tool.end", id });
  }
  agentSpawned(agentId, kind) {
    if (typeof agentId === "string") this.agents.set(agentId, String(kind || ""));
  }
  agentStart(agentId) {
    this.push({ type: "agent.start", id: agentId, kind: this.agents.get(agentId) || "" });
  }
  agentEnd(agentId) {
    this.agents.delete(agentId);
    this.push({ type: "agent.end", id: agentId });
  }
  sessionEnd() {
    this.push({ type: "session.end" });
    this.flushSoon();
  }
  schedule(ms = flushMs) {
    if (this.timer || this.inflight || this.disabled || !this.io) return;
    this.timer = true;
    const timer = quietly(() =>
      this.io.after(Math.max(1, ms), () => {
        this.timer = null;
        this.flush();
      }),
    );
    // No timer runs: the next report tries again.
    if (timer === undefined) this.timer = null;
  }
  flushSoon() {
    if (this.timer === null && !this.inflight) this.flush();
  }
  /** The queued reports as wire events; text runs send what they have not sent yet. */
  take() {
    const events = [];
    for (const item of this.queue) {
      if (!item.run) {
        events.push(item);
        continue;
      }
      const run = item.run;
      if (run.text.length <= run.sent) continue;
      events.push({
        type: "text",
        turn: run.turn,
        step: run.step,
        block: run.block,
        order: run.order,
        from: run.sent,
        text: run.text.slice(run.sent),
      });
      run.sent = run.text.length;
    }
    this.queue = [];
    return events;
  }
  /** Send the whole text of every current run again (AgentPier lost track). */
  resend() {
    for (const run of this.turn?.runs.values() || []) {
      run.sent = 0;
      this.queue.push({ run });
    }
  }
  async flush() {
    if (this.inflight || this.disabled || !this.io) return;
    this.inflight = true;
    let ok = false;
    let events = [];
    try {
      const config = await this.config;
      if (!config) {
        // No AgentPier here: stay quiet for the rest of this copy's life.
        this.disabled = true;
        this.queue = [];
        return;
      }
      events = this.take();
      if (!events.length) return void (ok = true);
      const response = await this.io.fetch(url, {
        method: "POST",
        socketPath: config.socketPath,
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
          "x-agentpier-session": config.session,
        },
        body: JSON.stringify({ protocol, events }),
      });
      ok = response.ok === true;
      // Not this launch's channel any more (another launch, a removed session).
      if ([401, 403, 404, 410].includes(response.status)) {
        this.disabled = true;
        this.queue = [];
        return;
      }
      if (ok && quietly(() => JSON.parse(response.text || "{}").resync)) this.resend();
    } catch {
      ok = false;
    } finally {
      this.inflight = false;
      if (!this.disabled) this.settle(ok, events);
    }
  }
  settle(ok, events) {
    if (ok) this.failures = 0;
    else {
      this.failures++;
      const again = events.filter((event) => kept.has(event.type));
      this.queue = [...again, ...this.queue];
      if (events.some((event) => event.type === "text")) this.resend();
    }
    if (this.queue.length)
      this.schedule(ok ? flushMs : Math.min(10000, flushMs * 2 ** this.failures));
  }
}

/** Forward a step's stream unchanged while `observe` reads each chunk. */
function tap(stream, observe) {
  const iterator = stream[Symbol.asyncIterator]();
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(value) {
      const result = await iterator.next(value);
      if (!result.done) quietly(() => observe(result.value));
      return result;
    },
    return(value) {
      return iterator.return
        ? iterator.return(value)
        : Promise.resolve({ done: true, value });
    },
    throw(error) {
      return iterator.throw ? iterator.throw(error) : Promise.reject(error);
    },
  };
}

// An observer never decides: should one of its hooks fail, the call goes on as if it
// were not there (`next(e)` replays what an earlier `next` settled to).
const pass = ($, e, next) => next(e);

/** @type {import('claude-code').Register} */
export const register = (on) => {
  const bridge = new Bridge();
  on("session.start", async ($, e, next) => {
    bridge.use({
      env: () =>
        Promise.all([
          $.env.get("AGENTPIER_CLAUDE_BRIDGE_SOCKET"),
          $.env.get("AGENTPIER_REQUEST_FILE"),
          $.env.get("AGENTPIER_REQUEST_TOKEN"),
        ]),
      after: (ms, fn) => $.clock.after(ms, fn),
      fetch: (target, init) => $.http.fetch(target, init),
    });
    const version = await $.session.version().then(
      (value) => value?.version,
      () => undefined,
    );
    quietly(() => bridge.hello(version));
    return next(e);
  });
  on("turn.start", ($, e, next) => {
    // A copy the engine replaced mid-session hears no `session.start`.
    if (!bridge.io)
      bridge.use({
        env: () =>
          Promise.all([
            $.env.get("AGENTPIER_CLAUDE_BRIDGE_SOCKET"),
            $.env.get("AGENTPIER_REQUEST_FILE"),
            $.env.get("AGENTPIER_REQUEST_TOKEN"),
          ]),
        after: (ms, fn) => $.clock.after(ms, fn),
        fetch: (target, init) => $.http.fetch(target, init),
      });
    quietly(() => bridge.turnStart(e));
    return next(e);
  });
  on("turn.step", async function* ($, e, next) {
    const observe = quietly(() => bridge.step(e));
    if (!observe) return yield* next(e);
    return yield* tap(next(e), observe);
  });
  on("turn.complete", ($, e, next) => {
    quietly(() => bridge.turnComplete(e));
    return next(e);
  });
  on("tool.call", async ($, e, next) => {
    const started = quietly(() => bridge.toolStart(e));
    try {
      return await next(e);
    } finally {
      if (started) quietly(() => bridge.toolEnd(e.tool_use_id));
    }
  }).catch(pass);
  on("agent.spawn", async ($, e, next) => {
    const result = await next(e);
    quietly(() => bridge.agentSpawned(result?.agentId, e.subagentType));
    return result;
  }).catch(pass);
  on("session.compact", async ($, e, next) => {
    // A precompute runs ahead in the background; it is no compaction yet.
    if (e.trigger === "precompute" || e.agentId !== undefined) return next(e);
    quietly(() => bridge.push({ type: "compact.start" }));
    try {
      return await next(e);
    } finally {
      quietly(() => bridge.push({ type: "compact.end" }));
    }
  }).catch(pass);
  on("session.end", ($, e, next) => {
    // `/clear` goes on in the same process under a new conversation.
    if (e.reason !== "clear") quietly(() => bridge.sessionEnd());
    return next(e);
  });
};
