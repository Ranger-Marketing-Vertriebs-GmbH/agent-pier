// Key operations for the session SSH agent. Callers pass identity text read from the
// managed identities folder; errors here are generic and never carry key material.
import { createRequire } from "node:module";
import ssh2 from "ssh2";
import { signFlags, WireReader, wireString } from "./ssh-agent-protocol.js";

const { utils } = ssh2;
const { convertSignature, sigSSHToASN1 } = createRequire(import.meta.url)(
  "ssh2/lib/protocol/utils.js",
);

const ecdsaTypes = new Set([
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
]);
const rsaHashes = new Map([
  ["rsa-sha2-512", "sha512"],
  ["rsa-sha2-256", "sha256"],
  ["ssh-rsa", "sha1"],
]);

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function unsupported() {
  return codedError("SSH_AGENT_KEY_UNSUPPORTED", "SSH key type or format not supported");
}

function supportedType(type) {
  return type === "ssh-ed25519" || type === "ssh-rsa" || ecdsaTypes.has(type);
}

export function publicKeyBlob(line) {
  if (typeof line !== "string") throw unsupported();
  const [type, base64] = line.trim().split(/\s+/);
  if (!type || !base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw unsupported();
  const blob = Buffer.from(base64, "base64");
  if (blob.toString("base64") !== base64) throw unsupported();
  const embedded = new WireReader(blob).string();
  if (embedded === undefined || embedded.toString("latin1") !== type) throw unsupported();
  return blob;
}

function parsePublicBlob(blob) {
  if (!Buffer.isBuffer(blob)) return null;
  const embedded = new WireReader(blob).string();
  if (embedded === undefined) return null;
  const key = utils.parseKey(blob);
  if (key instanceof Error || Array.isArray(key) || !key) return null;
  if (key.type !== embedded.toString("latin1") || !supportedType(key.type)) return null;
  return key;
}

function verifyAlgorithm(keyType, algorithm) {
  if (keyType === "ssh-rsa")
    return rsaHashes.has(algorithm) ? rsaHashes.get(algorithm) : null;
  return algorithm === keyType ? undefined : null;
}

export function verifySessionBind({ hostKeyBlob, sessionId, signature } = {}) {
  try {
    if (!Buffer.isBuffer(sessionId) || !Buffer.isBuffer(signature)) return false;
    const key = parsePublicBlob(hostKeyBlob);
    if (!key) return false;
    const reader = new WireReader(signature);
    const algorithm = reader.string();
    let raw = reader.string();
    if (algorithm === undefined || raw === undefined || !reader.done) return false;
    const hash = verifyAlgorithm(key.type, algorithm.toString("latin1"));
    if (hash === null) return false;
    if (ecdsaTypes.has(key.type)) {
      raw = sigSSHToASN1(raw, key.type);
      if (!raw) return false;
    }
    return key.verify(sessionId, raw, hash) === true;
  } catch {
    return false;
  }
}

function rsaAlgorithm(flags, allowSha1) {
  if (flags & signFlags.RSA_SHA2_512) return ["rsa-sha2-512", "sha512"];
  if (flags & signFlags.RSA_SHA2_256) return ["rsa-sha2-256", "sha256"];
  if (allowSha1) return ["ssh-rsa", "sha1"];
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

export function signUserauth(identityText, data, flags, { allowSha1 = false } = {}) {
  if (typeof identityText !== "string" && !Buffer.isBuffer(identityText))
    throw unsupported();
  const key = parsePrivate(identityText);
  let algorithm = key.type;
  let hash;
  if (key.type === "ssh-rsa") [algorithm, hash] = rsaAlgorithm(flags, allowSha1);
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
