import { serverMessagesReady, serverProblemText } from "../../lib/server-messages.js";
import { assistantAttachmentsCopy as copy } from "../../lib/i18n/messages/assistant-attachments.js";
import { uploadVideo } from "./agent-video-upload.js";

// The server checks every upload again by its bytes; these mirror its limits so the
// owner learns about a wrong file before it is sent.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 5;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const textNames =
  /\.(?:txt|text|md|markdown|log|json|jsonl|ndjson|ya?ml|toml|ini|conf|cfg|config|properties|csv|tsv|xml|html?|css|scss|less|[mc]?js|jsx|tsx?|py|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|graphql|gql|vue|svelte|lua|pl|r|scala|dart|diff|patch|srt|vtt|tex|rst|adoc|org|gradle|tf|hcl|nix)$/i;
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const heic = (file) =>
  /^image\/hei[cf](?:-sequence)?$/.test(file.type) || /\.hei[cf]$/i.test(file.name);
const videoTypes = /^video\/(?:mp4|quicktime|webm|x-m4v)$/;
const videoNames = /\.(?:mp4|m4v|mov|qt|webm)$/i;
export const isVideo = (file) => videoTypes.test(file.type) || videoNames.test(file.name);
// iOS offers photos and videos, the camera and Files for this list.
export const ACCEPT =
  "image/*,.heic,.heif,video/*,.mp4,.m4v,.mov,.webm,application/pdf,.pdf,text/*,.md,.log,.json,.yaml,.yml,.toml,.conf,.cfg,.ini,.csv,.tsv,.xml,.js,.ts,.py,.sh,.sql";

/** A translated reason the file cannot be attached, or "". */
export function fileProblem(file) {
  if (isVideo(file))
    return file.size > MAX_VIDEO_BYTES ? copy.videoTooLarge(file.name) : "";
  if (file.size > MAX_FILE_BYTES) return copy.tooLarge(file.name);
  if (
    imageTypes.has(file.type) ||
    heic(file) ||
    file.type === "application/pdf" ||
    /\.pdf$/i.test(file.name) ||
    textNames.test(file.name)
  )
    return "";
  return copy.unsupported(file.name);
}

export const isImage = (file) => imageTypes.has(file.type) || heic(file);

/**
 * HEIC photos become JPEG where the browser can decode them (Safari), so a vision
 * model can see them; elsewhere they are uploaded as they are and stay files.
 */
export async function preparedFile(file) {
  if (!heic(file) || typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob || blob.size > MAX_FILE_BYTES) return file;
    return new File([blob], `${file.name.replace(/\.hei[cf]$/i, "")}.jpg`, {
      type: "image/jpeg",
    });
  } catch {
    return file;
  }
}

/**
 * Sends raw bytes with upload progress (`progress(loaded)` in bytes). Resolves with
 * `{ status, result }`, status 0 when the request never got an answer. With
 * `stallMs` the request has no fixed timeout: it gives up only after that long
 * without progress, so a slow but moving line is never cut off.
 */
export function sendBytes(method, url, body, signal, progress = () => {}, stallMs = 0) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    let stall;
    const watch = () => {
      clearTimeout(stall);
      if (stallMs) stall = setTimeout(abort, stallMs);
    };
    const finish = (value) => {
      clearTimeout(stall);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    xhr.open(method, url);
    xhr.timeout = stallMs ? 0 : 120000;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      watch();
      progress(event.loaded);
    };
    // The body is out; the reply may take a moment longer.
    xhr.upload.onload = watch;
    watch();
    xhr.onload = () => {
      if (xhr.status === 401) window.dispatchEvent(new Event("agentpier-login-required"));
      let result = {};
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        /* Invalid replies fail with the caller's message. */
      }
      finish({ status: xhr.status, result });
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => finish({ status: 0, result: {} });
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(body);
  });
}

/** The translated error of a failed reply. */
export async function replyError(result) {
  // The English server catalog loads on demand; wait for it before translating.
  if (result.messageKey) await serverMessagesReady();
  return new Error(serverProblemText(result, copy.failed));
}

/** Uploads one file as raw bytes; resolves with the server's public record. */
export async function uploadAttachment(conversationId, file, signal, progress) {
  if (isVideo(file)) return uploadVideo(conversationId, file, signal, progress);
  const { status, result } = await sendBytes(
    "POST",
    `/api/assistant-conversations/${encodeURIComponent(conversationId)}/attachments?name=${encodeURIComponent(file.name)}`,
    file,
    signal,
    (loaded) => progress(Math.round((loaded / Math.max(1, file.size)) * 100)),
  );
  if (status === 201 && typeof result.id === "string") return result;
  throw await replyError(result);
}
