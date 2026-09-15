import { fileClientIssue } from "./file-api.js";

export function uploadFile(
  client,
  uploadId,
  file,
  { scopeId, signal, onProgress, owns = () => true },
) {
  return new Promise((resolve, reject) => {
    const current = () => !signal.aborted && owns();
    if (!scopeId || !uploadId) return reject(fileClientIssue("FILE_INVALID_SCOPE", 409));
    if (!current()) return reject(new DOMException("Aborted", "AbortError"));
    const xhr = new XMLHttpRequest();
    let settled = false;
    const abort = () => xhr.abort();
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      xhr.upload.onprogress = null;
      xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null;
      callback(value);
    };
    xhr.open("PUT", `${client.base}/uploads/${encodeURIComponent(uploadId)}/content`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-File-Scope", scopeId);
    xhr.upload.onprogress = (event) => {
      if (current())
        onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    };
    xhr.onload = () => {
      if (!current()) return finish(reject, new DOMException("Aborted", "AbortError"));
      if (xhr.status === 401) window.dispatchEvent(new Event("agentpier-login-required"));
      let body;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) {
        if (body?.id === uploadId && body.scopeId === scopeId && body.kind === "upload")
          finish(resolve, body);
        else finish(reject, fileClientIssue("FILE_INVALID_RESPONSE", xhr.status));
      } else {
        const code = /^FILE_[A-Z0-9_]+$/.test(body?.code || "") ? body.code : null;
        finish(reject, fileClientIssue(code, xhr.status, body?.args));
      }
    };
    xhr.onerror = xhr.ontimeout = () => finish(reject, fileClientIssue(null, 0));
    xhr.onabort = () => finish(reject, new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      xhr.send(file);
    } catch (error) {
      finish(reject, error);
    }
  });
}
