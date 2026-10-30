import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

export const speechEndpoints = Object.freeze({
  openai: "https://api.openai.com/v1/audio/speech",
  elevenlabs: "https://api.elevenlabs.io/v1/text-to-speech",
});
// The models that speak German and English alike.
export const speechModels = Object.freeze({
  openai: "gpt-4o-mini-tts",
  elevenlabs: "eleven_multilingual_v2",
});
export const speechOutputLimits = Object.freeze({
  // Readings at once per login session, and in all.
  perHolder: 1,
  concurrent: 4,
  // Readings a login session may start within the window.
  starts: 120,
  windowMs: 10 * 60 * 1000,
  // The upstream answer must begin within this time; the audio itself may take longer.
  timeoutMs: 30000,
  // A reading never streams more than this (about 25 minutes of 128 kbit/s MP3).
  maxBytes: 25 * 1024 * 1024,
});

/** A stable reason for a refused or failed reading; never upstream text. */
export function speechFailure(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "upstreamBusy";
  if (status === 400 || status === 422) return "rejected";
  return "failed";
}
export class SpeechOutputError extends Error {
  constructor(code, status = 502) {
    super(code);
    Object.assign(this, { code, status });
  }
}

function request({ provider, voice, apiKey }, text, endpoints) {
  if (provider === "openai")
    return {
      url: endpoints.openai,
      init: {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: speechModels.openai,
          voice,
          input: text,
          response_format: "mp3",
        }),
      },
    };
  const url = new URL(`${endpoints.elevenlabs}/${encodeURIComponent(voice)}/stream`);
  url.searchParams.set("output_format", "mp3_44100_128");
  return {
    url,
    init: {
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: speechModels.elevenlabs }),
    },
  };
}

/**
 * Speech output for agent replies (talk mode, AGENTPIER-291; read aloud, AGENTPIER-36):
 * text in, an MP3 stream out, through the provider and voice chosen in the speech
 * settings (voice-connections.js). The key stays here: the browser receives audio only,
 * and an upstream error becomes a stable code (`speechFailure`). Callers pass text they
 * read themselves (an agent reply, speech-text.js), so this is no open TTS proxy.
 */
export class SpeechOutput {
  constructor({
    voices,
    audit,
    fetchImpl = fetch,
    endpoints = speechEndpoints,
    clock = Date,
    limits = {},
  }) {
    Object.assign(this, { voices, audit, fetchImpl, endpoints, clock });
    this.limits = { ...speechOutputLimits, ...limits };
    this.running = new Map();
    this.starts = new Map();
  }
  /** Whether replies can be read aloud now, and with which provider. */
  status() {
    const voices = this.voices();
    if (!voices) return { available: false, reason: "agentsOff" };
    return voices.status();
  }
  admit(holder) {
    const now = this.clock.now();
    const recent = (this.starts.get(holder) || []).filter(
      (at) => now - at < this.limits.windowMs,
    );
    if (recent.length >= this.limits.starts) return "rateLimited";
    const total = [...this.running.values()].reduce((sum, n) => sum + n, 0);
    if ((this.running.get(holder) || 0) >= this.limits.perHolder) return "busy";
    if (total >= this.limits.concurrent) return "busy";
    recent.push(now);
    this.starts.set(holder, recent);
    return null;
  }
  release(holder) {
    const left = (this.running.get(holder) || 1) - 1;
    if (left > 0) this.running.set(holder, left);
    else this.running.delete(holder);
  }
  /**
   * Reads `text` aloud for login session `holder`. Resolves once the provider has
   * answered: `{ mime, provider, stream }`, a Node stream of MP3 bytes the caller pipes
   * on and must consume or destroy. Throws SpeechOutputError with a stable code.
   */
  async synthesize({ holder, text, signal }) {
    if (typeof text !== "string" || !text.trim())
      throw new SpeechOutputError("empty", 400);
    const voices = this.voices();
    const lease = voices?.acquire();
    if (!lease) throw new SpeechOutputError("voiceMissing", 409);
    const refused = this.admit(holder);
    if (refused) throw new SpeechOutputError(refused, 429);
    this.running.set(holder, (this.running.get(holder) || 0) + 1);
    const startedAt = this.clock.now();
    let released = false;
    const done = (outcome) => {
      if (released) return;
      released = true;
      this.release(holder);
      try {
        this.audit?.append({
          action: "speech.completed",
          resourceType: "speech",
          source: "user",
          outcome,
          details: {
            kind: "speech-output",
            seconds: Math.round((this.clock.now() - startedAt) / 1000),
            count: text.length,
          },
        });
      } catch {}
    };
    const { url, init } = request(lease, text, this.endpoints);
    // The answer must begin within `timeoutMs`; the audio then streams for as long as
    // the caller reads it (the browser closing its request aborts it).
    const answer = new AbortController();
    const timer = setTimeout(() => answer.abort(), this.limits.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([answer.signal, ...(signal ? [signal] : [])]),
      });
    } catch {
      clearTimeout(timer);
      done("failure");
      throw new SpeechOutputError(signal?.aborted ? "interrupted" : "failed");
    }
    clearTimeout(timer);
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      done("failure");
      throw new SpeechOutputError(speechFailure(response.status));
    }
    // The audio streams on; more than `maxBytes` ends it.
    let bytes = 0;
    const limit = this.limits.maxBytes;
    const body = response.body;
    const stream = Readable.from(
      (async function* () {
        for await (const chunk of body) {
          bytes += chunk.length;
          if (bytes > limit) throw new SpeechOutputError("tooLong");
          yield Buffer.from(chunk);
        }
      })(),
      { objectMode: false },
    );
    stream.once("close", () => done(stream.readableEnded ? "success" : "failure"));
    return { mime: "audio/mpeg", provider: lease.provider, stream };
  }
}
