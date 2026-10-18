// Deepgram's live streaming boundary for browser dictation (dictation-service.js):
// the address for 16 kHz mono PCM, its transcript messages and its refusals.
export const liveEndpoint = "wss://api.deepgram.com/v1/listen";
export const sampleRate = 16000;
const maxTranscript = 20000;

/** The live address for the stored model and language; the key goes in a header. */
export function deepgramLiveUrl({ model, language }, endpoint = liveEndpoint) {
  const url = new URL(endpoint);
  const params = url.searchParams;
  params.set("model", model);
  params.set("encoding", "linear16");
  params.set("sample_rate", String(sampleRate));
  params.set("channels", "1");
  params.set("interim_results", "true");
  params.set("smart_format", "true");
  params.set("punctuate", "true");
  // Streaming cannot detect the language: Nova-3 transcribes mixed speech as
  // "multi"; other models keep Deepgram's default.
  if (language !== "auto") params.set("language", language);
  else if (model.startsWith("nova-3")) params.set("language", "multi");
  if (model.startsWith("nova-3")) params.append("keyterm", "AgentPier");
  else if (model.startsWith("nova-2")) params.append("keywords", "AgentPier:2");
  return url;
}

/**
 * One Deepgram message as a transcript for the browser, or null. Interim results
 * are replaced by the next result; a final one closes its segment, even empty.
 */
export function parseLiveMessage(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (message?.type !== "Results") return null;
  const transcript = message.channel?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string" || transcript.length > maxTranscript) return null;
  const text = transcript
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const final = message.is_final === true;
  if (!text && !final) return null;
  return { type: "transcript", final, text };
}

/** A stable code for a refused or failed live connection; never upstream text. */
export function liveFailure({ status } = {}) {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "upstreamBusy";
  if (status === 400) return "rejected";
  return "failed";
}
