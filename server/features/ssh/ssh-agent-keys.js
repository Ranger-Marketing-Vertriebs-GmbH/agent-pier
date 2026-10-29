// Key operations for the session SSH agent. Callers pass identity text read from the
// managed identities folder; errors here are generic and never carry key material.
import { createRequire } from "node:module";
import ssh2 from "ssh2";
import { signFlags, WireReader, wireString } from "./ssh-agent-protocol.js";
import { codedError } from "./ssh-agent-shared.js";

const { utils } = ssh2;
const { convertSignature, sigSSHToASN1 } = createRequire(import.meta.url)(
  "ssh2/lib/protocol/utils.js",
);

const ecdsaTypes = new Set([
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
]);
const rsaAlgorithms = new Map([
  ["rsa-sha2-256", "sha256"],
  ["rsa-sha2-512", "sha512"],
  ["ssh-rsa", "sha1"],
]);

function unsupported() {
  return codedError("SSH_AGENT_KEY_UNSUPPORTED", "SSH key type or format not supported");
}

function supportedType(type) {
  return type === "ssh-ed25519" || type === "ssh-rsa" || ecdsaTypes.has(type);
}

function parsePublicBlob(blob) {
  if (!Buffer.isBuffer(blob)) return null;
  const embedded = new WireReader(blob).string();
  if (embedded === undefined || !supportedType(embedded.toString("latin1"))) return null;
  let key;
  try {
    key = utils.parseKey(blob);
  } catch {
    return null;
  }
  if (key instanceof Error || Array.isArray(key) || !key || key.isPrivateKey())
    return null;
  if (key.type !== embedded.toString("latin1")) return null;
  // Only the canonical encoding counts: ssh2 ignores trailing bytes after the key.
  const canonical = key.getPublicSSH();
  if (!Buffer.isBuffer(canonical) || !canonical.equals(blob)) return null;
  return key;
}

// The blob of an OpenSSH public key line "<type> <base64> [comment]", restricted to
// Ed25519, ECDSA (nistp256/384/521) and RSA keys in canonical form. Certificates and
// DSS keys are refused.
export function publicKeyBlob(line) {
  if (typeof line !== "string") throw unsupported();
  const [type, base64] = line.trim().split(/\s+/);
  if (!supportedType(type) || !base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw unsupported();
  const blob = Buffer.from(base64, "base64");
  if (blob.toString("base64") !== base64) throw unsupported();
  const key = parsePublicBlob(blob);
  if (!key || key.type !== type) throw unsupported();
  return blob;
}

function canonicalMpint(integer) {
  if (integer.length === 0 || integer[0] & 0x80) return false;
  return integer[0] !== 0 || (integer.length > 1 && (integer[1] & 0x80) !== 0);
}

// ECDSA signature body is exactly string(r) string(s), both positive minimal mpints.
function ecdsaDer(raw, type) {
  const reader = new WireReader(raw);
  const r = reader.string();
  const s = reader.string();
  if (r === undefined || s === undefined || !reader.done) return null;
  if (!canonicalMpint(r) || !canonicalMpint(s)) return null;
  return sigSSHToASN1(raw, type) || null;
}

function verifyAlgorithm(keyType, algorithm) {
  if (keyType === "ssh-rsa")
    return rsaAlgorithms.has(algorithm) ? rsaAlgorithms.get(algorithm) : null;
  return algorithm === keyType ? undefined : null;
}

// Returns the bind signature's algorithm name (for example "rsa-sha2-512" or
// "ssh-rsa") when the host signature over the session id verifies, false otherwise.
// Callers decide whether a SHA-1 "ssh-rsa" bind is acceptable for the host.
export function verifySessionBind({ hostKeyBlob, sessionId, signature } = {}) {
  try {
    if (!Buffer.isBuffer(sessionId) || !Buffer.isBuffer(signature)) return false;
    const key = parsePublicBlob(hostKeyBlob);
    if (!key) return false;
    const reader = new WireReader(signature);
    const algorithmBytes = reader.string();
    let raw = reader.string();
    if (algorithmBytes === undefined || raw === undefined || !reader.done) return false;
    const algorithm = algorithmBytes.toString("latin1");
    const hash = verifyAlgorithm(key.type, algorithm);
    if (hash === null) return false;
    if (ecdsaTypes.has(key.type)) {
      raw = ecdsaDer(raw, key.type);
      if (!raw) return false;
    }
    return key.verify(sessionId, raw, hash) === true ? algorithm : false;
  } catch {
    return false;
  }
}

// The signature algorithm the agent uses for a key type and SIGN_REQUEST flags. For
// RSA it follows OpenSSH's agent_decode_alg: RSA_SHA2_256 is tested before
// RSA_SHA2_512, so flags 2|4 select rsa-sha2-256; no flag means SHA-1 "ssh-rsa", which
// is refused (SSH_AGENT_LEGACY) unless allowSha1. Other types ignore the flags.
export function signatureAlgorithm(keyType, flags, { allowSha1 = false } = {}) {
  if (!supportedType(keyType)) throw unsupported();
  if (keyType !== "ssh-rsa") return keyType;
  if (flags & signFlags.RSA_SHA2_256) return "rsa-sha2-256";
  if (flags & signFlags.RSA_SHA2_512) return "rsa-sha2-512";
  if (allowSha1) return "ssh-rsa";
  throw codedError("SSH_AGENT_LEGACY", "SHA-1 RSA signatures are not allowed");
}

function parsePrivate(identityText) {
  let key;
  try {
    key = utils.parseKey(identityText);
  } catch {
    throw unsupported();
  }
  if (!key || key instanceof Error || Array.isArray(key)) throw unsupported();
  if (!key.isPrivateKey() || !supportedType(key.type)) throw unsupported();
  return key;
}

// Signs `data` with the private key in `identityText`. With `keyBlob`, a private key
// whose public half is not exactly that blob is refused (SSH_AGENT_KEY_UNSUPPORTED).
export function signUserauth(
  identityText,
  data,
  flags,
  { allowSha1 = false, keyBlob } = {},
) {
  if (typeof identityText !== "string" && !Buffer.isBuffer(identityText))
    throw unsupported();
  const key = parsePrivate(identityText);
  if (keyBlob !== undefined) {
    const own = key.getPublicSSH();
    if (!Buffer.isBuffer(keyBlob) || !Buffer.isBuffer(own) || !own.equals(keyBlob))
      throw unsupported();
  }
  const algorithm = signatureAlgorithm(key.type, flags, { allowSha1 });
  const hash = rsaAlgorithms.get(algorithm);
  let raw;
  try {
    raw = key.sign(data, hash);
  } catch {
    throw unsupported();
  }
  if (!Buffer.isBuffer(raw)) throw unsupported();
  if (ecdsaTypes.has(key.type)) {
    raw = convertSignature(raw, key.type);
    if (!Buffer.isBuffer(raw)) throw unsupported();
  }
  return Buffer.concat([wireString(algorithm), wireString(raw)]);
}
