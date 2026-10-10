import { DeepgramTranscriber } from "./deepgram-transcriber.js";
import { channelError } from "../assistant-channels/telegram-client.js";
const maxBytes = 10 * 1024 * 1024;
export class SpeechService {
  constructor({ connections, transcriber = new DeepgramTranscriber() }) {
    Object.assign(this, { connections, transcriber });
  }
  async transcribe({ voice, client, signal, assistantName, maxSeconds = 600 }) {
    if (voice.size > maxBytes || voice.duration > maxSeconds)
      throw channelError("MEDIA_TOO_LARGE", 400);
    if (voice.mime !== "audio/ogg" || !voice.fileId)
      throw channelError("MEDIA_UNSUPPORTED", 400);
    if (!this.connections.get().hasSecret)
      throw channelError("SPEECH_NOT_CONFIGURED", 400);
    const lease = this.connections.acquire();
    let audio;
    try {
      signal?.throwIfAborted();
      audio = await client.audio(voice.fileId, signal, maxBytes);
      if (audio.length > maxBytes) throw channelError("MEDIA_TOO_LARGE", 400);
      return await this.transcriber.transcribe({
        ...lease,
        audio,
        signal,
        assistantName,
      });
    } finally {
      audio?.fill(0);
      lease.release();
    }
  }
  async process(service, id, signal) {
    const { ledger, store, assistants, clientFactory } = service;
    const channel = store.get(id),
      entry = ledger.queue(id)[0];
    if (
      !channel.enabled ||
      !entry ||
      entry.state !== "voice_pending" ||
      !store.secret(id)
    )
      return;
    ledger.patch(entry.id, { state: "transcribing" });
    assistants.changed();
    try {
      const result = await this.transcribe({
        voice: entry.voice,
        client: clientFactory(store.secret(id)),
        signal,
        assistantName: assistants.store.getAssistant(channel.assistantId).name,
        maxSeconds: ledger.maxVoiceSeconds,
      });
      if (signal.aborted) throw channelError("TRANSCRIPTION_INTERRUPTED");
      ledger.patch(entry.id, {
        text: result.text,
        state: "queued",
        diagnostic: null,
        diagnosticDetail: null,
      });
    } catch (error) {
      const allowed = [
        "MEDIA_TOO_LARGE",
        "MEDIA_UNSUPPORTED",
        "MEDIA_DOWNLOAD",
        "SPEECH_NOT_CONFIGURED",
        "SPEECH_AUTH",
        "TRANSCRIPTION_EMPTY",
        "TRANSCRIPTION_INTERRUPTED",
        "TRANSCRIPTION_REJECTED",
        "TRANSCRIPTION_QUOTA",
        "TRANSCRIPTION_RATE_LIMITED",
      ];
      ledger.patch(entry.id, {
        state: "transcription_failed",
        diagnostic: allowed.includes(error.code) ? error.code : "TRANSCRIPTION_FAILED",
        // Bounded, sanitized upstream excerpt; the full response is never kept.
        diagnosticDetail:
          typeof error.detail === "string" ? error.detail.slice(0, 200) : null,
      });
    }
    assistants.changed();
  }
}
