import { serverMessagesReady, serverProblemText } from "../../lib/server-messages.js";
import { assistantAttachmentsCopy as copy } from "../../lib/i18n/messages/assistant-attachments.js";

// The server checks every upload again by its bytes; these mirror its limits so the
// owner learns about a wrong file before it is sent.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 5;
const textNames =
  /\.(?:txt|text|md|markdown|log|json|jsonl|ndjson|ya?ml|toml|ini|conf|cfg|config|properties|csv|tsv|xml|html?|css|scss|less|[mc]?js|jsx|tsx?|py|rb|go|rs|java|kts?|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|graphql|gql|vue|svelte|lua|pl|r|scala|dart|diff|patch|srt|vtt|tex|rst|adoc|org|gradle|tf|hcl|nix)$/i;
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const heic = (file) =>
  /^image\/hei[cf](?:-sequence)?$/.test(file.type) || /\.hei[cf]$/i.test(file.name);
// iOS offers photos, the camera and Files for this list.
export const ACCEPT =
  "image/*,.heic,.heif,application/pdf,.pdf,text/*,.md,.log,.json,.yaml,.yml,.toml,.conf,.cfg,.ini,.csv,.tsv,.xml,.js,.ts,.py,.sh,.sql";

/** A translated reason the file cannot be attached, or "". */
export function fileProblem(file) {
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

/** Uploads one file as raw bytes; resolves with the server's public record. */
export function uploadAttachment(conversationId, file, signal, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (callback, value) => {
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    xhr.open(
      "POST",
      `/api/assistant-conversations/${encodeURIComponent(conversationId)}/attachments?name=${encodeURIComponent(file.name)}`,
    );
    xhr.timeout = 120000;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable)
        progress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status === 401) window.dispatchEvent(new Event("agentpier-login-required"));
      let result = {};
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        /* Invalid replies fail below. */
      }
      if (xhr.status === 201 && typeof result.id === "string") finish(resolve, result);
      else
        // The English server catalog loads on demand; wait for it before translating.
        (result.messageKey ? serverMessagesReady() : Promise.resolve()).then(() =>
          finish(reject, new Error(serverProblemText(result, copy.failed))),
        );
    };
    xhr.onerror =
      xhr.ontimeout =
      xhr.onabort =
        () => finish(reject, new Error(copy.failed));
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}
