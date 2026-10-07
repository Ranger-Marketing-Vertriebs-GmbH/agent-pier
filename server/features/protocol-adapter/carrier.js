const PREFIX = "ap1";
const ORIGIN = /^[a-z0-9-]+$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
/** A lone base64url character is never valid base64, so it can mark "no payload". */
const NO_PAYLOAD = "-";

/**
 * Packs reasoning state into a string that is safe to hand to a client in a signature or
 * encrypted_content slot: `ap1.<origin>.<base64url>`. Real Anthropic signatures are standard
 * base64 and Codex encrypted_content has no such prefix, so neither decodes as a carrier.
 * A null or undefined payload encodes "no payload".
 */
export function encodeCarrier(origin, payload) {
  if (!ORIGIN.test(origin)) throw new RangeError("carrierOriginInvalid");
  const body =
    payload == null ? NO_PAYLOAD : Buffer.from(payload, "utf8").toString("base64url");
  return `${PREFIX}.${origin}.${body}`;
}

/**
 * Returns `{ origin, payload }` for a carrier string and null for anything else, including a
 * body that is not canonical base64url or does not decode to valid UTF-8.
 */
export function decodeCarrier(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !ORIGIN.test(parts[1])) return null;
  const [, origin, body] = parts;
  if (body === NO_PAYLOAD) return { origin, payload: null };
  if (!BASE64URL.test(body) || body.length % 4 === 1) return null;
  const bytes = Buffer.from(body, "base64url");
  if (bytes.toString("base64url") !== body) return null;
  const payload = bytes.toString("utf8");
  // Invalid UTF-8 decodes to U+FFFD replacements and does not re-encode to the same bytes.
  if (!Buffer.from(payload, "utf8").equals(bytes)) return null;
  return { origin, payload };
}
