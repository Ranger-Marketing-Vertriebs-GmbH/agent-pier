// Signing policy of the session SSH agent: which hosts a session's agent serves, which
// public keys it lists, and whether one SIGN_REQUEST may be signed. Pure functions; any
// unexpected value or throw is a refusal, never a signature.
import { publicKeyBlob, signatureAlgorithm } from "./ssh-agent-keys.js";
import { parseUserauthRequest, WireReader } from "./ssh-agent-protocol.js";

const minimumRsaHostKeyBits = 2048;
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

function verifiedBinding(binding) {
  return (
    binding !== null &&
    typeof binding === "object" &&
    binding.forwarding === false &&
    Buffer.isBuffer(binding.sessionId) &&
    Buffer.isBuffer(binding.hostKeyBlob) &&
    typeof binding.algorithm === "string" &&
    binding.algorithm.length > 0
  );
}

function grantedHost(hosts, binding, request, keyBlob) {
  if (!Array.isArray(hosts)) return null;
  return (
    hosts.find(
      (host) =>
        host.hostKeyBlob.equals(binding.hostKeyBlob) &&
        host.username === request.user &&
        host.keyBlob.equals(keyBlob),
    ) ?? null
  );
}

// Legacy rules for the chosen host: a SHA-1 bind (R19) and an RSA host key under 2048
// bits (R20) need "Legacy algorithms" on that host.
function legacyAllowed(host, binding) {
  if (host.legacy) return true;
  if (binding.algorithm === "ssh-rsa") return false;
  if (keyType(host.hostKeyBlob) === "ssh-rsa")
    return rsaBits(host.hostKeyBlob) >= minimumRsaHostKeyBits;
  return true;
}

function decide({ binding, keyBlob, data, flags, hosts }) {
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
  const host = grantedHost(hosts, binding, request, keyBlob);
  if (!host) return refuse("SSH_AGENT_NOT_GRANTED");
  if (!legacyAllowed(host, binding)) return refuse("SSH_AGENT_LEGACY");
  const type = keyType(keyBlob);
  if (!Number.isInteger(flags) || flags < 0) return refuse("SSH_AGENT_UNBOUND");
  const algorithm = signatureAlgorithm(type, flags, { allowSha1: host.legacy });
  if (algorithm !== request.algorithm) return refuse("SSH_AGENT_UNBOUND");
  return { ok: true, host };
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
