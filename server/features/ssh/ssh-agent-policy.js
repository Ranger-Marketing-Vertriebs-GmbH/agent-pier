// Signing policy of the session SSH agent: which hosts a session's agent serves, which
// public keys it lists, and whether one SIGN_REQUEST may be signed. Pure functions; any
// unexpected value or throw is a refusal, never a signature.
import { publicKeyBlob, signatureAlgorithm } from "./ssh-agent-keys.js";
import { parseUserauthRequest, WireReader } from "./ssh-agent-protocol.js";

const minimumRsaBits = 2048;
const maxU32 = 0xffffffff;
const rsaBindAlgorithms = new Set(["ssh-rsa", "rsa-sha2-256", "rsa-sha2-512"]);
const bindKeyTypes = new Set([
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
]);
const knownCodes = new Set([
  "SSH_AGENT_UNBOUND",
  "SSH_AGENT_FORWARDING",
  "SSH_AGENT_NOT_GRANTED",
  "SSH_AGENT_LEGACY",
  "SSH_AGENT_KEY_UNSUPPORTED",
]);

function blobOrNull(line) {
  try {
    return publicKeyBlob(line);
  } catch {
    return null;
  }
}

function agentHost(access) {
  if (!access || typeof access !== "object") return null;
  if (access.type !== "ssh" || access.interactiveShell || access.keyMissing) return null;
  if (typeof access.keyId !== "string" || !access.keyId) return null;
  const keyBlob = blobOrNull(access.publicKey);
  const hostKeyBlob = blobOrNull(access.hostKey);
  if (!keyBlob || !hostKeyBlob) return null;
  return {
    accessId: access.id,
    name: access.name,
    host: access.host,
    port: access.port,
    username: access.username,
    keyId: access.keyId,
    publicKey: access.publicKey,
    hostKey: access.hostKey,
    keyBlob,
    hostKeyBlob,
    legacy: access.legacyAlgorithms === true,
    createdAt: access.createdAt,
  };
}

// The SSH hosts of `accesses` (SshAccessStore.list() projections) named by
// `effectiveIds`, in that order. SFTP, interactive-shell, missing-key and unparsable
// rows are dropped, as are ids without a row.
export function agentHosts(accesses, effectiveIds) {
  if (!Array.isArray(accesses) || !Array.isArray(effectiveIds)) return [];
  const byId = new Map();
  for (const access of accesses) {
    if (access && typeof access.id === "string" && !byId.has(access.id))
      byId.set(access.id, access);
  }
  const seen = new Set();
  const hosts = [];
  for (const id of effectiveIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const host = agentHost(byId.get(id));
    if (host) hosts.push(host);
  }
  return hosts;
}

// The public keys the agent lists, once per key blob, in host order.
export function agentIdentities(hosts) {
  const seen = new Set();
  const identities = [];
  for (const host of hosts) {
    const id = host.keyBlob.toString("base64");
    if (seen.has(id)) continue;
    seen.add(id);
    identities.push({
      keyBlob: host.keyBlob,
      comment: `agentpier-${host.keyId.slice(0, 8)}`,
    });
  }
  return identities;
}

function keyType(blob) {
  const type = new WireReader(blob).string();
  return type === undefined ? null : type.toString("latin1");
}

// Modulus size of an ssh-rsa public key blob: string("ssh-rsa") mpint(e) mpint(n).
function rsaBits(blob) {
  const reader = new WireReader(blob);
  reader.string();
  reader.string();
  const modulus = reader.string();
  if (modulus === undefined) return 0;
  let offset = 0;
  while (offset < modulus.length && modulus[offset] === 0) offset += 1;
  if (offset === modulus.length) return 0;
  return (modulus.length - offset - 1) * 8 + (32 - Math.clz32(modulus[offset]));
}

function refuse(code) {
  return { ok: false, code };
}

// verifySessionBind returns ssh-rsa or rsa-sha2-* for an RSA host key and the key
// type itself otherwise; any other value cannot come from a verified bind.
function bindAlgorithmMatches(algorithm, hostKeyBlob) {
  if (typeof algorithm !== "string") return false;
  const type = keyType(hostKeyBlob);
  if (type === "ssh-rsa") return rsaBindAlgorithms.has(algorithm);
  return bindKeyTypes.has(type) && algorithm === type;
}

function verifiedBinding(binding) {
  return (
    binding !== null &&
    typeof binding === "object" &&
    binding.forwarding === false &&
    Buffer.isBuffer(binding.sessionId) &&
    binding.sessionId.length > 0 &&
    Buffer.isBuffer(binding.hostKeyBlob) &&
    bindAlgorithmMatches(binding.algorithm, binding.hostKeyBlob)
  );
}

// Every granted host with exactly this pinned host key, remote user and key. Several
// accesses may describe the same server, user and key; the strictest one decides.
function grantedHosts(hosts, binding, request, keyBlob) {
  if (!Array.isArray(hosts)) return [];
  return hosts.filter(
    (host) =>
      host.hostKeyBlob.equals(binding.hostKeyBlob) &&
      host.username === request.user &&
      host.keyBlob.equals(keyBlob),
  );
}

function rsaTooSmall(blob) {
  return keyType(blob) === "ssh-rsa" && rsaBits(blob) < minimumRsaBits;
}

// Legacy rules: a SHA-1 bind (R19) and an RSA host or user key under 2048 bits (R20)
// need "Legacy algorithms" on the host.
function legacyAllowed(legacy, binding, keyBlob) {
  if (legacy) return true;
  if (binding.algorithm === "ssh-rsa") return false;
  return !rsaTooSmall(binding.hostKeyBlob) && !rsaTooSmall(keyBlob);
}

function decide({ binding, keyBlob, data, flags, hosts }) {
  // The spec has five codes. A request whose data does not match the bound connection
  // (not userauth, other service, session id, host key, key blob, flags or algorithm)
  // is refused as SSH_AGENT_UNBOUND: it is not a sign request for this bind.
  if (!binding || typeof binding !== "object") return refuse("SSH_AGENT_UNBOUND");
  if (binding.forwarding === true) return refuse("SSH_AGENT_FORWARDING");
  if (!verifiedBinding(binding)) return refuse("SSH_AGENT_UNBOUND");
  if (!Buffer.isBuffer(keyBlob)) return refuse("SSH_AGENT_UNBOUND");
  const request = parseUserauthRequest(data);
  if (!request || request.service !== "ssh-connection")
    return refuse("SSH_AGENT_UNBOUND");
  if (!request.sessionId.equals(binding.sessionId)) return refuse("SSH_AGENT_UNBOUND");
  if (request.hostKeyBlob && !request.hostKeyBlob.equals(binding.hostKeyBlob))
    return refuse("SSH_AGENT_UNBOUND");
  if (!request.keyBlob.equals(keyBlob)) return refuse("SSH_AGENT_UNBOUND");
  const matches = grantedHosts(hosts, binding, request, keyBlob);
  if (matches.length === 0) return refuse("SSH_AGENT_NOT_GRANTED");
  const legacy = matches.every((match) => match.legacy === true);
  if (!legacyAllowed(legacy, binding, keyBlob)) return refuse("SSH_AGENT_LEGACY");
  if (!Number.isInteger(flags) || flags < 0 || flags > maxU32)
    return refuse("SSH_AGENT_UNBOUND");
  const algorithm = signatureAlgorithm(keyType(keyBlob), flags, { allowSha1: legacy });
  if (algorithm !== request.algorithm) return refuse("SSH_AGENT_UNBOUND");
  // The first match names the host for the audit; legacy is the strictest of all.
  return { ok: true, host: { ...matches[0], legacy } };
}

// Decides one SIGN_REQUEST. `binding` is the connection's last session-bind that
// verifySessionBind accepted, with its returned `algorithm`; a binding without one
// counts as unverified. Signs only a publickey userauth request for ssh-connection whose
// session id (and hostbound host key) equal the bind, whose key is the requested one,
// for a granted host with exactly that pinned host key, remote user and key, and whose
// signature algorithm equals the userauth algorithm field.
export function decideSignature(input) {
  try {
    return decide(input ?? {});
  } catch (error) {
    return refuse(knownCodes.has(error?.code) ? error.code : "SSH_AGENT_NOT_GRANTED");
  }
}
