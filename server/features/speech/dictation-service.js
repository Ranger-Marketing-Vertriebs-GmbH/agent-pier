import WebSocket from "ws";
import {
  deepgramLiveUrl,
  liveEndpoint,
  liveFailure,
  parseLiveMessage,
} from "./deepgram-live.js";

// 16-bit mono PCM at 16 kHz: 32,000 bytes a second.
const bytesPerSecond = 32000;
export const dictationLimits = Object.freeze({
  maxSeconds: 300,
  // Deepgram itself ends a stream after about ten seconds without audio.
  idleMs: 8000,
  // Audio the browser sends before Deepgram accepted the stream: about four seconds.
  maxPendingBytes: 4 * bytesPerSecond,
  // Audio waiting in the Deepgram socket (about 30 seconds): more means it stalled.
  maxUpstreamBuffer: 1024 * 1024,
  // Starts per login session within the window, and dictations open at once.
  starts: 20,
  windowMs: 10 * 60 * 1000,
  concurrent: 4,
  // How long the last transcripts may take after the owner stopped.
  finishMs: 5000,
});
const defaultConnect = (url, headers) =>
  new WebSocket(url, {
    headers,
    handshakeTimeout: 10000,
    maxPayload: 1 << 20,
    perMessageDeflate: false,
  });

/**
 * Live dictation for the owner's composers: the browser streams PCM through
 * AgentPier, which opens Deepgram's live socket with the stored key (the key never
 * reaches the browser) and relays interim and final transcripts back. Audio is only
 * forwarded, never stored, and each sent buffer is zeroed (best effort); the audit
 * records only that dictation was used and for how long.
 */
export class DictationService {
  constructor({
    speech,
    audit,
    connect = defaultConnect,
    endpoint = liveEndpoint,
    clock = Date,
    limits = {},
  }) {
    Object.assign(this, { speech, audit, connect, endpoint, clock });
    this.limits = { ...dictationLimits, ...limits };
    this.active = new Map();
    this.starts = new Map();
  }
  /** Whether the composers can offer dictation, and whether it sends right away. */
  status() {
    const speech = this.speech();
    if (!speech) return { available: false, reason: "agentsOff", autoSend: false };
    const settings = speech.get();
    return settings.hasSecret
      ? { available: true, autoSend: settings.dictationSend === true }
      : { available: false, reason: "notConfigured", autoSend: false };
  }
  admit(holder) {
    const now = this.clock.now();
    const recent = (this.starts.get(holder) || []).filter(
      (at) => now - at < this.limits.windowMs,
    );
    if (recent.length >= this.limits.starts) return "rateLimited";
    // A newer dictation of the same login session replaces the older one.
    const others = [...this.active.keys()].filter((key) => key !== holder).length;
    if (others >= this.limits.concurrent) return "busy";
    recent.push(now);
    this.starts.set(holder, recent);
    return null;
  }
  /**
   * Starts one dictation for login session `holder`; `client` receives
   * `{type, ...}` messages and is closed with a WebSocket close code.
   */
  start({ holder, client }) {
    const refusal = (code) => {
      client.send({ type: "error", code });
      client.close(1000);
      return { audio() {}, stop() {}, abort() {} };
    };
    const status = this.status();
    if (!status.available) return refusal(status.reason);
    const admitted = this.admit(holder);
    if (admitted) return refusal(admitted);
    this.active.get(holder)?.end("replaced");
    let lease;
    try {
      lease = this.speech().acquire();
    } catch {
      return refusal("notConfigured");
    }
    const session = new Dictation(this, { holder, client, lease });
    if (session.state !== "ended") this.active.set(holder, session);
    return session;
  }
  finished(session, { error, seconds }) {
    if (this.active.get(session.holder) === session) this.active.delete(session.holder);
    try {
      this.audit?.append({
        action: "speech.completed",
        resourceType: "speech",
        source: "user",
        outcome: error ? "failure" : "success",
        details: { kind: "dictation", seconds },
      });
    } catch {}
  }
  close() {
    for (const session of [...this.active.values()]) session.end("closed");
  }
}

class Dictation {
  constructor(service, { holder, client, lease }) {
    Object.assign(this, { service, holder, client });
    this.limits = service.limits;
    this.startedAt = service.clock.now();
    this.pending = [];
    this.pendingBytes = 0;
    this.state = "connecting";
    this.error = null;
    const headers = { Authorization: `Token ${lease.apiKey}` };
    const url = deepgramLiveUrl(lease, service.endpoint);
    try {
      this.upstream = service.connect(url, headers);
    } catch {
      lease.release();
      this.fail("failed");
      return;
    }
    // The key is needed only for the handshake; settings stay editable meanwhile.
    const release = () => lease.release();
    this.upstream.once("open", release);
    this.upstream.once("close", release);
    this.upstream.on("open", () => this.opened());
    this.upstream.on("message", (data, binary) => {
      if (binary) return;
      const transcript = parseLiveMessage(data);
      if (transcript) this.client.send(transcript);
    });
    this.upstream.on("unexpected-response", (_request, response) => {
      response.resume?.();
      this.fail(liveFailure({ status: response.statusCode }));
    });
    this.upstream.on("error", () => this.fail("failed"));
    this.upstream.on("close", (code) => {
      if (this.state === "finishing") return this.finish(this.reason || "stopped");
      if (this.state !== "ended") this.fail(code === 1008 ? "rejected" : "failed");
    });
    this.maxTimer = setTimeout(() => this.stop("limit"), this.limits.maxSeconds * 1000);
    this.maxTimer.unref?.();
    this.touch();
  }
  opened() {
    if (this.state !== "connecting") return;
    this.state = "recording";
    for (const chunk of this.pending)
      if (this.state === "recording") this.forward(chunk);
      else chunk.fill(0);
    this.pending = [];
    this.pendingBytes = 0;
    this.client.send({ type: "ready", maxSeconds: this.limits.maxSeconds });
  }
  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop("idle"), this.limits.idleMs);
    this.idleTimer.unref?.();
  }
  forward(chunk) {
    if (this.upstream.bufferedAmount > this.limits.maxUpstreamBuffer) {
      chunk.fill(0);
      return this.fail("slow");
    }
    // Best effort: ws may still hold a masked copy until the frame is written.
    this.upstream.send(chunk, () => chunk.fill(0));
  }
  /** One frame of 16 kHz mono PCM from the browser. */
  audio(chunk) {
    if (!["connecting", "recording"].includes(this.state)) return chunk.fill(0);
    if (!chunk.length || chunk.length % 2) return this.fail("invalid");
    this.touch();
    if (this.state === "recording") return this.forward(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes > this.limits.maxPendingBytes) return this.fail("failed");
    this.pending.push(chunk);
  }
  /** Asks Deepgram for the last transcripts, then ends with `reason`. */
  stop(reason = "stopped") {
    if (this.state === "connecting") return this.finish(reason);
    if (this.state !== "recording") return;
    this.state = "finishing";
    this.reason = reason;
    clearTimeout(this.idleTimer);
    try {
      this.upstream.send(JSON.stringify({ type: "CloseStream" }));
    } catch {}
    this.finishTimer = setTimeout(() => this.finish(reason), this.limits.finishMs);
    this.finishTimer.unref?.();
  }
  fail(code) {
    if (this.state === "ended") return;
    this.error = code;
    this.client.send({ type: "error", code });
    this.end(null);
  }
  finish(reason) {
    if (this.state === "ended") return;
    this.client.send({ type: "ended", reason });
    this.end(null);
  }
  /** Ends at once: the browser left, a newer dictation replaced it, or shutdown. */
  end(reason) {
    if (this.state === "ended") return;
    if (reason) this.client.send({ type: "ended", reason });
    this.state = "ended";
    for (const timer of [this.maxTimer, this.idleTimer, this.finishTimer])
      clearTimeout(timer);
    for (const chunk of this.pending) chunk.fill(0);
    this.pending = [];
    try {
      this.upstream?.terminate?.();
    } catch {}
    this.client.close(1000);
    const seconds = Math.round((this.service.clock.now() - this.startedAt) / 1000);
    this.service.finished(this, { error: this.error, seconds });
  }
  abort() {
    this.end(null);
  }
}
