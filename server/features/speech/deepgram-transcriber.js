import { boundedBytes, channelError } from "../assistant-channels/telegram-client.js";
const retries = 3;
const statusCodes = {
  400: "TRANSCRIPTION_REJECTED",
  401: "SPEECH_AUTH",
  402: "TRANSCRIPTION_QUOTA",
  403: "SPEECH_AUTH",
  429: "TRANSCRIPTION_RATE_LIMITED",
};
const reported = [...new Set(Object.values(statusCodes)), "TRANSCRIPTION_EMPTY"];
// At most 200 printable characters of an upstream error body, never the key.
function excerpt(body, apiKey) {
  let text = body.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
  if (apiKey) text = text.replaceAll(apiKey, "[redacted]");
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
// Same direct-HTTP boundary as Mimisbrunnr's stt.Ears: audio in, normalized text out.
export class DeepgramTranscriber {
  constructor({ fetchImpl = fetch, sleep } = {}) {
    this.fetchImpl = fetchImpl;
    this.sleep =
      sleep ||
      ((ms, signal) =>
        new Promise((resolve, reject) => {
          signal?.throwIfAborted();
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }));
  }
  // A rate limit proves Deepgram did not process the audio, so the request is
  // repeated with growing pauses (or the advertised Retry-After) a few times.
  async request(url, init, signal) {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(30000),
          ...(signal ? [signal] : []),
        ]),
      });
      if (response.status !== 429 || attempt === retries) return response;
      await response.body?.cancel();
      const advertised = Number(response.headers.get("retry-after"));
      await this.sleep(
        Number.isFinite(advertised) && advertised > 0
          ? Math.min(advertised, 30) * 1000
          : 1000 * 2 ** attempt,
        signal,
      );
    }
  }
  async transcribe({ audio, apiKey, model, language, assistantName, signal }) {
    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", model);
    url.searchParams.set("smart_format", "true");
    if (language === "auto") url.searchParams.set("detect_language", "true");
    else url.searchParams.set("language", language);
    for (const term of [...new Set(["AgentPier", assistantName].filter(Boolean))]) {
      if (model.startsWith("nova-3")) url.searchParams.append("keyterm", term);
      else if (model.startsWith("nova-2"))
        url.searchParams.append("keywords", `${term.replaceAll(":", " ")}:2`);
    }
    try {
      const response = await this.request(
        url,
        {
          method: "POST",
          headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/ogg" },
          body: audio,
          redirect: "error",
        },
        signal,
      );
      if (!response.ok) {
        const body = await boundedBytes(response, 4096)
          .then((bytes) => bytes.toString())
          .catch(() => "");
        throw channelError(statusCodes[response.status] || "TRANSCRIPTION_FAILED", 503, {
          detail: excerpt(body, apiKey) || null,
        });
      }
      const data = JSON.parse((await boundedBytes(response, 2 * 1024 * 1024)).toString());
      const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript;
      if (typeof transcript !== "string" || !transcript.trim())
        throw channelError("TRANSCRIPTION_EMPTY");
      if (transcript.length > 60000 || transcript.includes("\0"))
        throw channelError("TRANSCRIPTION_FAILED");
      return {
        text: transcript.trim(),
        duration: Number.isFinite(data.metadata?.duration)
          ? data.metadata.duration
          : null,
      };
    } catch (error) {
      throw channelError(
        reported.includes(error.code)
          ? error.code
          : signal?.aborted
            ? "TRANSCRIPTION_INTERRUPTED"
            : "TRANSCRIPTION_FAILED",
        503,
        error.detail ? { detail: error.detail } : {},
      );
    }
  }
}
