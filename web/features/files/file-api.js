import { apiCopy } from "../../lib/i18n/messages/components.js";
import { fileErrorMessage } from "../../lib/i18n/messages/files.js";

function safeArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) =>
      ["string", "number", "boolean"].includes(typeof item),
    ),
  );
}

function scopedBase(scopeRef) {
  if (scopeRef?.kind === "global") return "/api/files";
  if (
    scopeRef?.kind === "project" &&
    typeof scopeRef.sessionId === "string" &&
    scopeRef.sessionId
  )
    return `/api/sessions/${encodeURIComponent(scopeRef.sessionId)}/files/explorer`;
  throw new TypeError("A global or project file scope is required.");
}

function suffixPath(suffix) {
  if (
    typeof suffix !== "string" ||
    !suffix.startsWith("/") ||
    suffix.includes("?") ||
    suffix.includes("#") ||
    suffix.includes("\0") ||
    suffix.split("/").some((part) => part === "." || part === "..")
  )
    throw new TypeError("A file API path suffix is required.");
  return suffix;
}

function urlFor(base, suffix, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {}))
    if (value !== undefined && value !== null) params.set(key, String(value));
  return `${base}${suffixPath(suffix)}${params.size ? `?${params}` : ""}`;
}

function headersFor(headers, { json = false, scopeId } = {}) {
  const result = new Headers(headers);
  if (json) result.set("Content-Type", "application/json");
  if (scopeId !== undefined) result.set("X-File-Scope", scopeId);
  return result;
}

function requireScopeId(scopeId) {
  if (typeof scopeId !== "string" || !scopeId)
    throw new TypeError("A scopeId from the opened file context is required.");
}

async function checked(response) {
  if (response.status === 401)
    globalThis.window?.dispatchEvent?.(new Event("agentpier-login-required"));
  if (response.ok) return response;
  const data = await response.json().catch(() => ({}));
  const code =
    typeof data.code === "string" && /^FILE_[A-Z0-9_]+$/.test(data.code)
      ? data.code
      : null;
  const error = new Error();
  Object.defineProperty(error, "message", {
    configurable: true,
    enumerable: false,
    get: () =>
      code
        ? fileErrorMessage(code, response.status)
        : apiCopy.requestFailed(response.status),
  });
  error.status = response.status;
  error.code = code;
  error.args = safeArgs(data.args);
  throw error;
}

export function fileApi(scopeRef) {
  const base = scopedBase(scopeRef);
  return {
    base,
    async get(path, query = {}, signal) {
      const response = await checked(await fetch(urlFor(base, path, query), { signal }));
      return response.json();
    },
    async mutate(path, { method = "POST", body, scopeId, signal, headers = {} } = {}) {
      requireScopeId(scopeId);
      const response = await checked(
        await fetch(urlFor(base, path), {
          method,
          signal,
          headers: headersFor(headers, { json: body !== undefined, scopeId }),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return response.json().catch(() => ({}));
    },
    async raw(
      path,
      { method = "GET", query = {}, body, scopeId, signal, headers = {} } = {},
    ) {
      if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()))
        requireScopeId(scopeId);
      return checked(
        await fetch(urlFor(base, path, query), {
          method,
          signal,
          headers: headersFor(headers, { scopeId }),
          ...(body === undefined ? {} : { body }),
        }),
      );
    },
  };
}
