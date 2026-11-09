/**
 * The technical detail of why staging an agent runtime update failed: the server's
 * `{ code, upstreamStatus }` (runtime-updates.js stageCause) as "ECONNRESET" or
 * "HTTP 429", both joined by " · "; "" without a usable cause. Codes stay as the
 * server reports them: they are diagnostic evidence, not product copy.
 */
export function updateCauseDetail(cause) {
  if (!cause || typeof cause !== "object") return "";
  const code =
    typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code)
      ? cause.code
      : null;
  const status = Number.isInteger(cause.upstreamStatus) ? cause.upstreamStatus : null;
  return [code, status && `HTTP ${status}`].filter(Boolean).join(" · ");
}
