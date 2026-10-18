import api from "../../lib/api.js";
import { replyError, sendBytes } from "./agent-attachment-upload.js";

// The server takes a video in chunks of at most 8 MiB (agent-video-types.js): a
// slow phone line never meets a request timeout, and a dropped chunk is resent alone.
export const VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;
const RETRIES = 3;
const wait = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => clearTimeout(timer) || resolve(), {
      once: true,
    });
  });

/**
 * Uploads a video chunk by chunk; `progress` receives whole percent of the file.
 * A chunk without an answer is retried; a reply naming where the copy ends (409
 * with `received`) continues from there. An aborted upload is discarded on the
 * server as well.
 */
export async function uploadVideo(conversationId, file, signal, progress) {
  const path = `/assistant-conversations/${encodeURIComponent(conversationId)}/video-uploads`;
  const base = `/api${path}`;
  const percent = (bytes) =>
    progress(Math.min(100, Math.floor((bytes / file.size) * 100)));
  let upload = null;
  let offset = 0;
  let failures = 0;
  let conflicts = 0;
  try {
    while (!signal.aborted) {
      const chunk = file.slice(offset, offset + VIDEO_CHUNK_BYTES);
      const url = upload
        ? `${base}/${encodeURIComponent(upload)}?offset=${offset}`
        : `${base}?name=${encodeURIComponent(file.name)}&size=${file.size}`;
      const start = offset;
      const { status, result } = await sendBytes(
        upload ? "PUT" : "POST",
        url,
        chunk,
        signal,
        (loaded) => percent(start + loaded),
      );
      if (signal.aborted) break;
      if ((status === 200 || status === 201) && typeof result.id === "string") {
        upload = null;
        progress(100);
        return result;
      }
      if ((status === 200 || status === 201) && typeof result.upload === "string") {
        upload = result.upload;
        // A reply that takes nothing ends the upload instead of repeating forever.
        if (!(result.received > start)) throw await replyError({});
        offset = result.received;
        percent(offset);
        failures = conflicts = 0;
        continue;
      }
      if (
        status === 409 &&
        upload &&
        Number.isSafeInteger(result.received) &&
        ++conflicts <= RETRIES
      ) {
        offset = result.received;
        continue;
      }
      // No answer, or the server was busy: try the same chunk again.
      if ((status === 0 || status >= 502) && ++failures <= RETRIES && upload) {
        await wait(1000 * 2 ** (failures - 1), signal);
        continue;
      }
      throw await replyError(result);
    }
    throw new Error("aborted");
  } finally {
    if (upload) api(`${path}/${encodeURIComponent(upload)}`, "DELETE").catch(() => {});
  }
}
