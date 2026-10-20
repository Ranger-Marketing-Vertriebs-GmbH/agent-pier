import net from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { messages, send } from "./wire.js";
import { maxReplyText } from "./native-push.js";

// Replies a channel holds at once; the oldest is forgotten first.
const maxRuns = 16;

/** Reconnectable native-side channel. Only the native owner decides whether a request still exists. */
export class NativeRequestChannel {
  constructor({ env = process.env, onDisconnect = () => {}, adapterVersion } = {}) {
    this.onDisconnect = onDisconnect;
    this.adapterVersion = adapterVersion;
    this.launch = JSON.parse(fs.readFileSync(env.AGENTPIER_REQUEST_FILE, "utf8"));
    if (this.launch.token !== env.AGENTPIER_REQUEST_TOKEN)
      throw Error("Invalid native request launch");
    this.epoch = randomUUID();
    this.pending = new Map();
    // Reply text streaming now, whole: a reconnect sends it again from the start.
    this.runs = new Map();
    this.closed = false;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.connect();
  }
  connect() {
    if (this.closed) return;
    const socket = (this.socket = net.createConnection(this.launch.socketPath));
    socket.on("connect", () =>
      send(socket, {
        type: "hello",
        sessionId: this.launch.id,
        token: this.launch.token,
        epoch: this.epoch,
        ...(this.adapterVersion ? { adapterVersion: this.adapterVersion } : {}),
      }),
    );
    socket.on("error", () => {});
    messages(socket, async (message) => {
      if (message.type === "ready") {
        this.connected = true;
        this.resolveReady();
        for (const [key, entry] of this.pending)
          if (entry.status === "pending")
            send(socket, { type: "publish", key, request: entry.request });
        for (const [runId, run] of this.runs) {
          run.sent = 0;
          this.flush(runId, run);
        }
      }
      if (message.type !== "answer") return;
      const entry = this.pending.get(message.key);
      if (!entry || entry.status !== "pending")
        return void send(socket, {
          type: "result",
          delivery: message.delivery,
          status: "stale",
        });
      // Claim before awaiting native I/O; neither reconnect nor duplicate commands can redeliver.
      entry.status = "responding";
      try {
        await entry.deliver(message.answer);
        this.pending.delete(message.key);
        send(socket, { type: "result", delivery: message.delivery, status: "answered" });
      } catch (error) {
        entry.status = error?.stale ? "stale" : "unknown";
        send(socket, {
          type: "result",
          delivery: message.delivery,
          status: entry.status,
        });
      }
    });
    socket.on("close", () => {
      this.connected = false;
      if (!this.closed) this.onDisconnect();
      if (!this.closed) {
        this.timer = setTimeout(() => this.connect(), 1000);
        this.timer.unref?.();
      }
    });
  }
  publish(key, request, deliver) {
    if (this.pending.has(key)) return;
    this.pending.set(key, { request, deliver, status: "pending" });
    if (this.connected) send(this.socket, { type: "publish", key, request });
  }
  /** A hint that the session's history changed; lost while disconnected. */
  activity(event) {
    if (this.connected)
      send(this.socket, { type: "activity", ...(event ? { event } : {}) });
  }
  /** Append reply text to run `runId` ({thread, turn} label it). */
  streamDelta(runId, delta, meta = {}) {
    const run = this.runs.get(runId);
    this.streamText(runId, (run?.text || "") + delta, meta);
  }
  /** The reply so far of run `runId`; a rewrite starts it again. */
  streamText(runId, text, meta = {}) {
    if (typeof text !== "string" || !text) return;
    text = text.slice(0, maxReplyText);
    let run = this.runs.get(runId);
    if (run && !text.startsWith(run.text)) run.sent = 0;
    if (!run) {
      run = { text: "", sent: 0, meta };
      this.runs.set(runId, run);
      if (this.runs.size > maxRuns) this.runs.delete(this.runs.keys().next().value);
    }
    run.text = text;
    this.flush(runId, run);
  }
  flush(runId, run) {
    if (!this.connected || run.text.length <= run.sent) return;
    send(this.socket, {
      type: "stream",
      runId,
      from: run.sent,
      text: run.text.slice(run.sent),
      ...run.meta,
    });
    run.sent = run.text.length;
  }
  /** Run `runId` ended; without one, every run (of `turn`, when given) ended. */
  streamEnd(runId, { turn } = {}) {
    const ended = runId
      ? [runId]
      : [...this.runs]
          .filter(([, run]) => !turn || run.meta.turn === turn)
          .map(([id]) => id);
    for (const id of ended) {
      if (!this.runs.delete(id)) continue;
      if (this.connected) send(this.socket, { type: "stream-end", runId: id });
    }
  }
  resolve(key, outcome) {
    this.pending.delete(key);
    send(this.socket, { type: "resolved", key, ...(outcome ? { outcome } : {}) });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
    this.pending.clear();
    this.runs.clear();
  }
}
