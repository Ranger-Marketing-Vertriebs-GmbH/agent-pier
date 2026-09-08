import { isIP } from "node:net";
import { ECDH } from "node:crypto";
import { problem } from "../../lib/storage.js";
export function pushId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value))
    throw problem("Invalid notification identifier.");
  return value;
}
function key(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw problem("Invalid push subscription key.");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value)
    throw problem("Invalid push subscription key.");
  return bytes;
}
export function pushSubscription(input) {
  if (!input || typeof input.endpoint !== "string" || input.endpoint.length > 4096)
    throw problem("Invalid push subscription.");
  let url;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw problem("Invalid push endpoint.");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    isIP(hostname.replace(/^\[|\]$/g, "")) ||
    !hostname.includes(".") ||
    hostname.endsWith(".") ||
    /\.(?:localhost|local|internal)$/.test(hostname) ||
    !/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)
  )
    throw problem("Push requires a public HTTPS endpoint.");
  const publicKey = key(input.keys?.p256dh, 65);
  key(input.keys?.auth, 16);
  try {
    ECDH.convertKey(publicKey, "prime256v1", undefined, undefined, "uncompressed");
  } catch {
    throw problem("Invalid push public key.");
  }
  return {
    endpoint: url.href,
    keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
  };
}
export function pushPayload(input) {
  if (
    ![
      "permission",
      "question",
      "session-ended",
      "session-completed",
      "pipeline-gate",
      "pipeline-ended",
      "test",
    ].includes(input?.kind)
  )
    throw problem("Invalid notification kind.");
  const payload = { kind: input.kind, eventId: pushId(input.eventId) };
  if (input.kind.startsWith("pipeline-")) payload.runId = pushId(input.runId);
  else if (input.kind !== "test") payload.sessionId = pushId(input.sessionId);
  return payload;
}
