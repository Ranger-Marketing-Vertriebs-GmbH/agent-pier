import { chatAttachmentsCopy as copy } from "../../lib/i18n/de/chat.js";

export function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(copy.uploadFailed));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export async function uploadFile(session, file, signal, progress) {
  const image = session.attachments && file.type.startsWith("image/");
  const previewUrl = file.type.startsWith("image/") ? await fileDataUrl(file) : null;
  if (signal.aborted) throw new Error(copy.uploadFailed);
  const stored = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (callback, result) => {
      signal.removeEventListener("abort", abort);
      callback(result);
    };
    xhr.open(
      "POST",
      `/api/sessions/${encodeURIComponent(session.id)}/chat/attachments${image ? "" : `?name=${encodeURIComponent(file.name)}`}`,
    );
    xhr.timeout = 60000;
    xhr.setRequestHeader(
      "Content-Type",
      image ? "application/json" : "application/octet-stream",
    );
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
      if (
        xhr.status >= 200 &&
        xhr.status < 300 &&
        typeof result.path === "string" &&
        typeof result.name === "string"
      )
        finish(resolve, result);
      else finish(reject, new Error(result.error || copy.uploadFailed));
    };
    xhr.onerror =
      xhr.ontimeout =
      xhr.onabort =
        () => finish(reject, new Error(copy.uploadFailed));
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(
      image ? JSON.stringify({ name: file.name, data: previewUrl.split(",")[1] }) : file,
    );
  });
  return { key: stored.path, name: stored.name, path: stored.path, previewUrl };
}
