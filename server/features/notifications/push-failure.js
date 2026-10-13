import { serverMessages } from "../../lib/i18n/de.js";

const reasonLimit = 160;

/**
 * Short, log-safe reason from a push service's refusal body. Apple answers JSON
 * `{"reason": "BadJwtToken"}`, Mozilla JSON with `message`/`error`, FCM plain text.
 * URLs and token-like runs are masked so endpoints, keys and JWTs never persist.
 */
export function pushRefusalReason(body) {
  if (typeof body !== "string" || !body.trim()) return undefined;
  let text = body;
  try {
    const parsed = JSON.parse(body);
    const candidate = [parsed?.reason, parsed?.message, parsed?.error].find(
      (value) => typeof value === "string" && value.trim(),
    );
    if (candidate) text = candidate;
  } catch {
    // Plain-text refusal (FCM) stays as written.
  }
  const reason = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9_+/=.-]{40,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, reasonLimit)
    .trim();
  return reason || undefined;
}

const reasonMessages = {
  BadJwtToken: "refusedSignature",
  BadAuthorizationHeader: "refusedSignature",
  ExpiredJwtToken: "refusedExpiredSignature",
  VapidPkHashMismatch: "refusedKey",
  BadVapidPublicKey: "refusedKey",
  TooManyRequests: "refusedRateLimit",
  PayloadTooLarge: "refusedPayload",
  BadTtl: "refusedRequest",
  BadUrgency: "refusedRequest",
  BadWebPushTopic: "refusedRequest",
  BadWebPushRequest: "refusedRequest",
  BadPath: "refusedRequest",
  MethodNotAllowed: "refusedRequest",
  InternalServerError: "refusedUnavailable",
  ServiceUnavailable: "refusedUnavailable",
  Shutdown: "refusedUnavailable",
  IdleTimeout: "refusedUnavailable",
};
const statusMessages = { 413: "refusedPayload", 429: "refusedRateLimit" };

/** Owner-facing `lastFailure` text for a failed delivery, in the German catalog. */
export function pushFailureText(error) {
  const messages = serverMessages.notifications;
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : undefined;
  const reason = typeof error?.reason === "string" ? error.reason : undefined;
  if (status === undefined) return messages.deliveryFailed;
  const known = Object.hasOwn(reasonMessages, reason ?? "")
    ? reasonMessages[reason]
    : statusMessages[status];
  if (known) return messages[known](reason ? `${status} ${reason}` : `HTTP ${status}`);
  return messages.deliveryFailedWithReason(
    reason ? `HTTP ${status}: ${reason}` : `HTTP ${status}`,
  );
}
