import api from "../../lib/api.js";
import { replyError, sendBytes } from "./agent-attachment-upload.js";

// The server takes a video in chunks of at most 8 MiB (agent-video-types.js): a
// slow phone line never meets a request timeout, and a dropped chunk is resent alone.
export const VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;
// A chunk is given up after this long without progress, however slow the line.
export const VIDEO_STALL_MS = 60000;
const RETRIES = 3;
const wait = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => clearTimeout(timer) || resolve(), {
      once: true,
    });
  });
// A random v4 UUID; crypto.randomUUID needs a secure context, which a phone on
// the plain-HTTP LAN address is not.
function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const ok = (status) => status === 200 || status === 201;

/**
 * Uploads a video chunk by chunk; `progress` receives whole percent of the file.
 * The page names the upload, so any chunk, the first and the last included, can be
 * sent again when its reply is lost: the server answers with where the copy ends
 * (409 with `received`) or with the staged file. A chunk without an answer is
 * retried; progress resets the retry budget. An aborted upload is discarded on the
 * server as well. `deps` replaces the transport in tests.
 */
export async function uploadVideo(conversationId, file, signal, progress, deps = {}) {
  const { send = sendBytes, pause = wait, id = randomId(), remove = api } = deps;
  const path = `/assistant-conversations/${encodeURIComponent(conversationId)}/video-uploads`;
  const base = `/api${path}`;
  const percent = (bytes) =>
    progress(Math.min(100, Math.floor((bytes / file.size) * 100)));
  let started = false;
  let offset = 0;
  let failures = 0;
  let conflicts = 0;
  let staged = false;
  try {
    while (!signal.aborted) {
      const chunk = file.slice(offset, offset + VIDEO_CHUNK_BYTES);
      const url = started
        ? `${base}/${encodeURIComponent(id)}?offset=${offset}`
        : `${base}?name=${encodeURIComponent(file.name)}&size=${file.size}&upload=${id}`;
      const start = offset;
      const { status, result } = await send(
        started ? "PUT" : "POST",
        url,
        chunk,
        signal,
        (loaded) => percent(start + loaded),
        VIDEO_STALL_MS,
      );
      if (signal.aborted) break;
      if (ok(status) && typeof result.id === "string") {
        staged = true;
        progress(100);
        return result;
      }
      if (ok(status) && result.upload === id) {
        started = true;
        // A reply that takes nothing ends the upload instead of repeating forever.
        if (!(result.received > start)) throw await replyError({});
        offset = result.received;
        percent(offset);
        failures = conflicts = 0;
        continue;
      }
      if (status === 409 && Number.isSafeInteger(result.received)) {
        started = true;
        // The copy grew since the last answer: the line is slow, not broken.
        if (result.received > offset) failures = conflicts = 0;
        if (++conflicts <= RETRIES) {
          offset = result.received;
          percent(offset);
          continue;
        }
      }
      // No answer, or the server was busy: send the same chunk again.
      // A 409 conflict: the server still finishes the chunk this page gave up on.
      const busy = status === 409 && result.messageKey === "assistants.conflict";
      if ((status === 0 || status >= 502 || busy) && ++failures <= RETRIES) {
        await pause(1000 * 2 ** (failures - 1), signal);
        continue;
      }
      throw await replyError(result);
    }
    throw new Error("aborted");
  } finally {
    if (!staged) remove(`${path}/${encodeURIComponent(id)}`, "DELETE").catch(() => {});
  }
}
