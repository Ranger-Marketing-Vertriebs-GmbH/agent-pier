// What the `agentpier-bridge` mod reports about a Claude Code session, held in
// memory only: the turn running now, its reply text (token by token, into the
// provider-neutral reply streams), the tool call the model is writing (`preparing`),
// the tools and subagents running and whether the model is thinking or compacting.
// A session whose mod reported is "mod active":
// its MessageDisplay drafts are ignored and its turn reports decide Working and Idle
// instead of the terminal reading (preferModActivity, session-activity-merge.js).
// Streamed text is passed on, never logged or stored. Its prompt reports (a prompt
// that entered or a hook dropped) go to the chat delivery's acceptance matcher.
const maxTools = 32;
const maxAgents = 64;
const runId = (turn, step, block) => `claude-mod-${turn}-${step}-${block}`;
// A `/compact` runs outside any turn, and it is work all the same.
const busy = (state) => Boolean(state.turn) || state.phase === "compacting";

export class ClaudeModBridge {
  /**
   * `streams` is ChatStreams (streamText, endStream, setStatus); `drafts` the
   * MessageDisplay drafts it replaces; `onActivity(id)` asks an open chat to read
   * its transcript again. Each report of a mod copy that reports prompts readies the
   * session's acceptance source (`onReady(id)`), each prompt report reaches
   * `onPrompt(id, event)` dated by this server, and `onForget(id)` ends the source
   * with the mod's state.
   */
  constructor({
    streams,
    drafts,
    onActivity = () => {},
    onReady = () => {},
    onPrompt = () => {},
    onForget = () => {},
    now = Date.now,
  }) {
    Object.assign(this, {
      streams,
      drafts,
      onActivity,
      onReady,
      onPrompt,
      onForget,
      now,
    });
    this.sessions = new Map();
  }
  /** Tell the acceptance matcher; it is advisory and never fails a report. */
  acceptance(name, ...args) {
    try {
      this[name](...args);
    } catch {
      /* The delivery falls back to its timeout. */
    }
  }
  /** Whether the mod reports for this launch of the session. */
  active(sessionId) {
    return this.sessions.has(sessionId);
  }
  /** The mod's activity report for the session-activity merge, or null. */
  activity(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      state: busy(state) ? "working" : "idle",
      event: "mod",
      at: state.at,
      mod: true,
      ...(state.turnAt ? { turnAt: state.turnAt } : {}),
    };
  }
  /**
   * One request's events, in order; `{resync: true}` asks the mod for whole runs.
   * `prompts` tells that the mod copy reports prompts: a copy launched before an
   * update does not, and its session keeps the text fallback.
   */
  receive(sessionId, events, { prompts = false } = {}) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        at: 0,
        turn: null,
        phase: null,
        preparing: null,
        tools: new Map(),
        agents: new Map(),
      };
      this.sessions.set(sessionId, state);
      // From now on the mod's text replaces the MessageDisplay drafts.
      this.drafts?.end(sessionId);
    }
    state.at = this.now();
    // Any report proves the mod runs here: a restarted server hears no new hello.
    if (prompts) this.acceptance("onReady", sessionId);
    let resync = false;
    for (const event of events) {
      if (event.type === "session.end") {
        this.forget(sessionId);
        return {};
      }
      if (event.type === "prompt.accepted" || event.type === "prompt.dropped")
        this.acceptance("onPrompt", sessionId, {
          kind: event.type === "prompt.accepted" ? "accepted" : "dropped",
          at: state.at,
          imageNames: event.images,
          imageCount: event.images.length,
          ...(event.queued !== undefined ? { queued: event.queued } : {}),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        });
      if (event.type === "turn.start") this.startTurn(sessionId, state, event.turn);
      if (event.type === "text") resync ||= !this.text(sessionId, state, event);
      if (event.type === "tool.prepare") this.prepare(sessionId, state, event);
      if (event.type === "phase" && state.turn?.id === event.turn) {
        state.phase = "thinking";
        state.preparing = null;
      }
      if (event.type === "tool.start") {
        if (state.preparing?.id === event.id) state.preparing = null;
        if (state.tools.size < maxTools) state.tools.set(event.id, event.name);
        if (state.phase === "thinking") state.phase = null;
      }
      if (event.type === "tool.end") state.tools.delete(event.id);
      if (event.type === "agent.start" && state.agents.size < maxAgents)
        state.agents.set(event.id, event.kind);
      if (event.type === "agent.end") state.agents.delete(event.id);
      if (event.type === "compact.start") {
        state.phase = "compacting";
        state.preparing = null;
      }
      if (event.type === "compact.end" && state.phase === "compacting")
        state.phase = null;
      if (event.type === "turn.complete") this.endTurn(sessionId, state, event.turn);
    }
    this.publish(sessionId, state);
    return resync ? { resync: true } : {};
  }
  /** A text delta; false when its offset does not fit (the mod resends). */
  text(sessionId, state, event) {
    if (state.turn?.id !== event.turn) this.startTurn(sessionId, state, event.turn);
    const id = runId(event.turn, event.step, event.block);
    // A run that gave way to a tool call is in the transcript: a resend stays out.
    if (state.turn.ended.has(id)) return true;
    state.phase = null;
    state.preparing = null;
    state.turn.runs.set(id, { step: event.step, block: event.block });
    return this.streams.streamText(sessionId, id, {
      text: event.text,
      from: event.from,
      turn: event.turn,
      order: event.order,
    });
  }
  /**
   * The model began a tool call: its name shows while the input streams, and the
   * turn's text blocks before it are complete, so their runs end and the
   * transcript, which already holds them, takes over.
   */
  prepare(sessionId, state, event) {
    if (state.turn?.id !== event.turn) this.startTurn(sessionId, state, event.turn);
    state.phase = null;
    state.preparing = event.name ? { id: event.id, name: event.name } : null;
    for (const [id, run] of state.turn.runs)
      if (run.step < event.step || (run.step === event.step && run.block < event.block)) {
        state.turn.runs.delete(id);
        state.turn.ended.add(id);
        this.streams.endStream(sessionId, id);
      }
  }
  startTurn(sessionId, state, turn) {
    if (state.turn && state.turn.id !== turn)
      this.streams.endStream(sessionId, undefined, { turn: state.turn.id });
    state.turn = { id: turn, runs: new Map(), ended: new Set() };
    state.turnAt = this.now();
    state.phase = null;
    state.preparing = null;
    state.tools.clear();
  }
  endTurn(sessionId, state, turn) {
    // The turn's text gives way to its transcript (an interrupted one too).
    this.streams.endStream(sessionId, undefined, { turn });
    if (state.turn && state.turn.id !== turn) return;
    state.turn = null;
    state.phase = null;
    state.preparing = null;
    state.tools.clear();
    this.onActivity(sessionId);
  }
  publish(sessionId, state) {
    const tools = [...state.tools.values()];
    const status = {
      state: busy(state) ? "working" : "idle",
      ...(state.phase ? { phase: state.phase } : {}),
      ...(state.preparing ? { preparing: state.preparing.name } : {}),
      ...(tools.length ? { tool: tools.at(-1), tools: tools.length } : {}),
      ...(state.agents.size ? { agents: state.agents.size } : {}),
    };
    // `at` is when this status began, so an unchanged status sends no frame.
    const key = JSON.stringify(status);
    if (key !== state.status) {
      state.status = key;
      state.statusAt = state.at;
    }
    this.streams.setStatus(sessionId, { ...status, at: state.statusAt });
  }
  /** A new launch, a stopped session or the mod's goodbye: back to the fallbacks. */
  forget(sessionId) {
    this.acceptance("onForget", sessionId);
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    if (state.turn) this.streams.endStream(sessionId, undefined, { turn: state.turn.id });
    this.streams.setStatus(sessionId, null);
    this.onActivity(sessionId);
  }
}

/**
 * The CLI's own report when the mod is active: its turns decide, except for what
 * only the settings hooks see. A dialog they reported after the mod's last event
 * (an approval, a question) is waiting, and background tasks a Stop reported keep
 * a finished turn working.
 */
export function preferModActivity(mod, hook) {
  if (!mod) return hook;
  if (hook?.state === "waiting" && hook.at >= mod.at) return hook;
  if (
    mod.state === "idle" &&
    hook?.state === "working" &&
    hook.event === "Stop" &&
    hook.background > 0 &&
    hook.at >= (mod.turnAt || 0)
  )
    return hook;
  return mod;
}
