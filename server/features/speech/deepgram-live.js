// Deepgram's live streaming boundary for browser dictation (dictation-service.js):
// the address for 16 kHz mono PCM, its transcript messages and its refusals.
export const liveEndpoint = "wss://api.deepgram.com/v1/listen";
export const sampleRate = 16000;
const maxTranscript = 20000;

// Talk mode (talk-sessions.js) sends a turn once the speaker paused: Deepgram marks
// the end of speech after this much silence (`speech_final`) and reports an
// utterance end once no word followed for `utteranceEndMs`.
export const talkEndpointing = Object.freeze({
  endpointingMs: 700,
  utteranceEndMs: 1500,
});

/**
 * The live address for the stored model and language; the key goes in a header.
 * `talk` asks Deepgram to mark the end of each utterance.
 */
export function deepgramLiveUrl(
  { model, language },
  endpoint = liveEndpoint,
  talk = false,
) {
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
  if (talk) {
    params.set("endpointing", String(talkEndpointing.endpointingMs));
    params.set("utterance_end_ms", String(talkEndpointing.utteranceEndMs));
    params.set("vad_events", "true");
  }
  return url;
}

/**
 * One Deepgram message as a transcript for the browser, or null. Interim results
 * are replaced by the next result; a final one closes its segment, even empty.
 * In talk mode a final result also says whether the speaker paused (`speechFinal`),
 * and Deepgram's utterance end becomes `{ type: "utteranceEnd" }`.
 */
export function parseLiveMessage(raw, { talk = false } = {}) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (talk && message?.type === "UtteranceEnd") return { type: "utteranceEnd" };
  if (message?.type !== "Results") return null;
  const transcript = message.channel?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string" || transcript.length > maxTranscript) return null;
  const text = transcript
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const final = message.is_final === true;
  if (!text && !final) return null;
  if (talk && final)
    return {
      type: "transcript",
      final,
      text,
      speechFinal: message.speech_final === true,
    };
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
