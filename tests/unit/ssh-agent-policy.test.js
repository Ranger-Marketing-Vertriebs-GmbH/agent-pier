import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicKeyBlob } from "../../server/features/ssh/ssh-agent-keys.js";
import {
  agentHosts,
  agentIdentities,
  decideSignature,
} from "../../server/features/ssh/ssh-agent-policy.js";

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ssh-agent-policy-"));
process.on("exit", () => fs.rmSync(folder, { recursive: true, force: true }));

let counter = 0;
function publicLine(type, extra = []) {
  counter += 1;
  const file = path.join(folder, `key-${counter}`);
  execFileSync("ssh-keygen", ["-q", "-N", "", "-t", type, ...extra, "-f", file]);
  const [kind, base64] = fs.readFileSync(`${file}.pub`, "utf8").trim().split(" ");
  return `${kind} ${base64}`;
}

const keyA = publicLine("ed25519");
const keyB = publicLine("ed25519");
const keyC = publicLine("ed25519");
const rsaKey = publicLine("rsa", ["-b", "2048"]);
const hostKeyA = publicLine("ed25519");
const hostKeyB = publicLine("ed25519");
const hostKeyC = publicLine("ed25519");
const rsaHostKey = publicLine("rsa", ["-b", "3072"]);
const smallRsaHostKey = publicLine("rsa", ["-b", "1024"]);
const smallRsaKey = publicLine("rsa", ["-b", "1024"]);
const blob = (line) => publicKeyBlob(line);

function access(id, overrides = {}) {
  return {
    id,
    name: `Host ${id}`,
    host: `${id}.example.test`,
    port: 22,
    username: "deploy",
    keyId: "0123abcd-1111-2222-3333-444444444444",
    publicKey: keyA,
    hostKey: hostKeyA,
    type: "ssh",
    legacyAlgorithms: false,
    interactiveShell: false,
    createdAt: "2026-10-29T00:00:00.000Z",
    ...overrides,
  };
}

const ssh = access("access-a");
const hostB = access("access-b", {
  publicKey: keyB,
  hostKey: hostKeyB,
  keyId: "4567beef-1111-2222-3333-444444444444",
});
// Granted to another session only: never part of this session's hosts.
const otherSession = access("access-c", { publicKey: keyC, hostKey: hostKeyC });
const sftp = access("sftp-1", { type: "sftp" });
const consoleHost = access("console-1", { interactiveShell: true });
const missingKey = access("missing-1", { keyMissing: true, publicKey: null });
const ids = ["access-a", "sftp-1", "console-1", "missing-1"];

const sessionId = Buffer.alloc(32, 7);
const other = Buffer.alloc(32, 8);
const hostbound = "publickey-hostbound-v00@openssh.com";

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
}

function userauth({
  sessionId: id = sessionId,
  user = "deploy",
  service = "ssh-connection",
  method = "publickey",
  algorithm = "ssh-ed25519",
  keyBlob = blob(keyA),
  hostKey = blob(hostKeyA),
} = {}) {
  return Buffer.concat([
    sshString(id),
    Buffer.from([50]),
    sshString(user),
    sshString(service),
    sshString(method),
    Buffer.from([1]),
    sshString(algorithm),
    sshString(keyBlob),
    ...(method === "publickey" ? [] : [sshString(hostKey)]),
  ]);
}

const bound = {
  sessionId,
  hostKeyBlob: blob(hostKeyA),
  forwarding: false,
  algorithm: "ssh-ed25519",
};

function rsaAlgorithm(flags) {
  if (flags & 2) return "rsa-sha2-256";
  if (flags & 4) return "rsa-sha2-512";
  return "ssh-rsa";
}

// Builds a sign request for host A of this session; `change` replaces single parts.
function input({
  rsa = false,
  legacy = false,
  hostKey = hostKeyA,
  userKey,
  ...change
} = {}) {
  const key = userKey ?? (rsa ? rsaKey : keyA);
  const rsaUser = key.startsWith("ssh-rsa ");
  const flags = change.flags ?? (rsaUser ? 4 : 0);
  const accesses = [
    access("access-a", { publicKey: key, hostKey, legacyAlgorithms: legacy }),
    hostB,
    sftp,
    consoleHost,
    missingKey,
    otherSession,
  ];
  const bindAlgorithm = hostKey.startsWith("ssh-rsa ") ? "rsa-sha2-512" : "ssh-ed25519";
  const binding = { ...bound, hostKeyBlob: blob(hostKey), algorithm: bindAlgorithm };
  return {
    binding,
    keyBlob: blob(key),
    data: userauth({
      algorithm: rsaUser ? rsaAlgorithm(flags) : "ssh-ed25519",
      keyBlob: blob(key),
      hostKey: blob(hostKey),
    }),
    flags,
    hosts: agentHosts(accesses, ["access-a", "access-b", ...ids.slice(1)]),
    ...change,
  };
}

const notUserauth = Buffer.concat([sshString(sessionId), Buffer.from([51])]);

const cases = [
  ["no bind", { binding: null }, "SSH_AGENT_UNBOUND"],
  [
    "empty session id in bind and userauth",
    {
      binding: { ...bound, sessionId: Buffer.alloc(0) },
      data: userauth({ sessionId: Buffer.alloc(0) }),
    },
    "SSH_AGENT_UNBOUND",
  ],
  [
    "unverified bind (no algorithm)",
    { binding: { ...bound, algorithm: undefined } },
    "SSH_AGENT_UNBOUND",
  ],
  [
    "bind without a session id",
    { binding: { ...bound, sessionId: "x" } },
    "SSH_AGENT_UNBOUND",
  ],
  [
    "forwarding bind",
    { binding: { ...bound, forwarding: true } },
    "SSH_AGENT_FORWARDING",
  ],
  ["data is not userauth", { data: Buffer.from("commit") }, "SSH_AGENT_UNBOUND"],
  ["data is another SSH message", { data: notUserauth }, "SSH_AGENT_UNBOUND"],
  ["data is not a buffer", { data: "userauth" }, "SSH_AGENT_UNBOUND"],
  [
    "service is not ssh-connection",
    { data: userauth({ service: "ssh-userauth" }) },
    "SSH_AGENT_UNBOUND",
  ],
  [
    "session id differs from the bind",
    { data: userauth({ sessionId: other }) },
    "SSH_AGENT_UNBOUND",
  ],
  [
    "hostbound host key differs from the bind",
    { data: userauth({ method: hostbound, hostKey: blob(hostKeyB) }) },
    "SSH_AGENT_UNBOUND",
  ],
  [
    "userauth names another key than the request",
    { data: userauth({ keyBlob: blob(keyB) }) },
    "SSH_AGENT_UNBOUND",
  ],
  ["other remote user", { data: userauth({ user: "root" }) }, "SSH_AGENT_NOT_GRANTED"],
  [
    "bound to an unpinned host key",
    { binding: { ...bound, hostKeyBlob: blob(hostKeyC) } },
    "SSH_AGENT_NOT_GRANTED",
  ],
  [
    "bound to another granted host's pinned key",
    { binding: { ...bound, hostKeyBlob: blob(hostKeyB) } },
    "SSH_AGENT_NOT_GRANTED",
  ],
  [
    "bound host key differs by a trailing byte",
    {
      binding: {
        ...bound,
        hostKeyBlob: Buffer.concat([blob(hostKeyA), Buffer.from([0])]),
      },
    },
    "SSH_AGENT_NOT_GRANTED",
  ],
  [
    "key of another host",
    { keyBlob: blob(keyB), data: userauth({ keyBlob: blob(keyB) }) },
    "SSH_AGENT_NOT_GRANTED",
  ],
  [
    "key granted to another session",
    {
      binding: { ...bound, hostKeyBlob: blob(hostKeyC) },
      keyBlob: blob(keyC),
      data: userauth({ keyBlob: blob(keyC) }),
    },
    "SSH_AGENT_NOT_GRANTED",
  ],
  ["no granted hosts", { hosts: [] }, "SSH_AGENT_NOT_GRANTED"],
  [
    "mismatched algorithm (ed25519 key, rsa name)",
    { data: userauth({ algorithm: "rsa-sha2-512" }) },
    "SSH_AGENT_UNBOUND",
  ],
  [
    "mismatched algorithm (rsa flags 4, userauth rsa-sha2-256)",
    {
      rsa: true,
      flags: 4,
      data: userauth({ algorithm: "rsa-sha2-256", keyBlob: blob(rsaKey) }),
    },
    "SSH_AGENT_UNBOUND",
  ],
  ["sha1 on a modern host", { flags: 0, rsa: true }, "SSH_AGENT_LEGACY"],
  [
    "sha1 bind on a modern host",
    {
      binding: { ...bound, algorithm: "ssh-rsa", hostKeyBlob: blob(rsaHostKey) },
      hostKey: rsaHostKey,
    },
    "SSH_AGENT_LEGACY",
  ],
  [
    "small RSA host key on a modern host",
    {
      binding: {
        ...bound,
        algorithm: "rsa-sha2-512",
        hostKeyBlob: blob(smallRsaHostKey),
      },
      hostKey: smallRsaHostKey,
    },
    "SSH_AGENT_LEGACY",
  ],
  ["small RSA user key on a modern host", { userKey: smallRsaKey }, "SSH_AGENT_LEGACY"],
  [
    "bind algorithm not a known algorithm",
    { binding: { ...bound, algorithm: "x" } },
    "SSH_AGENT_UNBOUND",
  ],
  [
    "bind algorithm of another key type than the host key",
    { binding: { ...bound, algorithm: "rsa-sha2-512" } },
    "SSH_AGENT_UNBOUND",
  ],
  [
    "rsa bind algorithm named for an ed25519 host key",
    { binding: { ...bound, algorithm: "ssh-rsa" } },
    "SSH_AGENT_UNBOUND",
  ],
  ["flags above the u32 range", { rsa: true, flags: 2 ** 32 + 4 }, "SSH_AGENT_UNBOUND"],
  ["negative flags", { rsa: true, flags: -1 }, "SSH_AGENT_UNBOUND"],
  ["hosts is not a list", { hosts: null }, "SSH_AGENT_NOT_GRANTED"],
];

for (const [name, change, code] of cases) {
  test(`refuses: ${name}`, () => {
    assert.deepEqual(decideSignature(input(change)), { ok: false, code });
  });
}

test("signs for a granted host, user and key", () => {
  const decision = decideSignature(input({}));
  assert.equal(decision.ok, true);
  assert.equal(decision.host.accessId, "access-a");
});

test("signs a hostbound request whose host key equals the bind", () => {
  const decision = decideSignature(
    input({ data: userauth({ method: hostbound, hostKey: blob(hostKeyA) }) }),
  );
  assert.equal(decision.host.accessId, "access-a");
});

test("signs for a second granted host with its own key and host key", () => {
  const decision = decideSignature(
    input({
      binding: { ...bound, hostKeyBlob: blob(hostKeyB) },
      keyBlob: blob(keyB),
      data: userauth({ keyBlob: blob(keyB) }),
    }),
  );
  assert.equal(decision.host.accessId, "access-b");
});

test("rsa signs with rsa-sha2-512 and rsa-sha2-256 on a modern host", () => {
  assert.equal(decideSignature(input({ rsa: true, flags: 4 })).ok, true);
  assert.equal(decideSignature(input({ rsa: true, flags: 2 })).ok, true);
});

test("sha1 is allowed only for a legacy host", () => {
  assert.equal(decideSignature(input({ flags: 0, rsa: true, legacy: true })).ok, true);
});

test("a sha1 bind is allowed for a legacy host", () => {
  const request = input({ hostKey: rsaHostKey, legacy: true });
  request.binding = { ...request.binding, algorithm: "ssh-rsa" };
  assert.equal(decideSignature(request).ok, true);
});

test("a 3072-bit RSA host key with an rsa-sha2 bind signs on a modern host", () => {
  const request = input({ hostKey: rsaHostKey });
  request.binding = { ...request.binding, algorithm: "rsa-sha2-512" };
  assert.equal(decideSignature(request).ok, true);
});

test("a small RSA host key is allowed for a legacy host", () => {
  assert.equal(
    decideSignature(input({ hostKey: smallRsaHostKey, legacy: true })).ok,
    true,
  );
});

test("a small RSA user key is allowed for a legacy host", () => {
  assert.equal(decideSignature(input({ userKey: smallRsaKey, legacy: true })).ok, true);
});

test("duplicate grants: legacy only if every match is legacy, in both orders", () => {
  const legacyRow = access("dup-legacy", { publicKey: rsaKey, legacyAlgorithms: true });
  const modernRow = access("dup-modern", { publicKey: rsaKey });
  for (const order of [
    ["dup-legacy", "dup-modern"],
    ["dup-modern", "dup-legacy"],
  ]) {
    const hosts = agentHosts([legacyRow, modernRow], order);
    assert.deepEqual(decideSignature(input({ rsa: true, flags: 0, hosts })), {
      ok: false,
      code: "SSH_AGENT_LEGACY",
    });
    const modern = decideSignature(input({ rsa: true, flags: 4, hosts }));
    assert.equal(modern.ok, true);
    assert.equal(modern.host.accessId, order[0]);
    assert.equal(modern.host.legacy, false);
    const smallHost = agentHosts(
      [
        { ...legacyRow, hostKey: smallRsaHostKey },
        { ...modernRow, hostKey: smallRsaHostKey },
      ],
      order,
    );
    const request = input({ hostKey: smallRsaHostKey, rsa: true, hosts: smallHost });
    assert.deepEqual(decideSignature(request), { ok: false, code: "SSH_AGENT_LEGACY" });
  }
  const bothLegacy = agentHosts(
    [legacyRow, { ...modernRow, legacyAlgorithms: true }],
    ["dup-modern", "dup-legacy"],
  );
  const sha1 = decideSignature(input({ rsa: true, flags: 0, hosts: bothLegacy }));
  assert.equal(sha1.ok, true);
  assert.equal(sha1.host.legacy, true);
});

test("forwarding is refused before anything else is looked at", () => {
  const request = input({ data: Buffer.from("junk"), hosts: [] });
  request.binding = { ...bound, forwarding: true };
  assert.deepEqual(decideSignature(request), { ok: false, code: "SSH_AGENT_FORWARDING" });
});

test("a host that throws while being read counts as a refusal", () => {
  const trap = {};
  Object.defineProperty(trap, "hostKeyBlob", {
    get() {
      throw new Error("boom");
    },
  });
  assert.deepEqual(decideSignature(input({ hosts: [trap] })), {
    ok: false,
    code: "SSH_AGENT_NOT_GRANTED",
  });
  assert.deepEqual(decideSignature(undefined), { ok: false, code: "SSH_AGENT_UNBOUND" });
});

test("agentHosts drops sftp, interactive-shell and missing-key rows", () => {
  assert.deepEqual(
    agentHosts([ssh, sftp, consoleHost, missingKey], ids).map((h) => h.accessId),
    ["access-a"],
  );
});

test("agentHosts keeps the effective id order and drops ungranted and bad rows", () => {
  const broken = access("broken-1", { publicKey: "ssh-ed25519 AAAA" });
  const badHostKey = access("broken-2", { hostKey: "ssh-dss AAAAB3NzaC1kc3M=" });
  const hosts = agentHosts(
    [ssh, hostB, otherSession, broken, badHostKey],
    ["access-b", "broken-1", "access-a", "broken-2", "unknown", "access-a"],
  );
  assert.deepEqual(
    hosts.map((h) => h.accessId),
    ["access-b", "access-a"],
  );
});

test("agentHosts projects the fields an agent needs", () => {
  const [host] = agentHosts(
    [access("access-a", { legacyAlgorithms: true })],
    ["access-a"],
  );
  assert.deepEqual(Object.keys(host).sort(), [
    "accessId",
    "createdAt",
    "host",
    "hostKey",
    "hostKeyBlob",
    "keyBlob",
    "keyId",
    "legacy",
    "name",
    "port",
    "publicKey",
    "username",
  ]);
  assert.equal(host.legacy, true);
  assert.ok(host.keyBlob.equals(blob(keyA)));
  assert.ok(host.hostKeyBlob.equals(blob(hostKeyA)));
  assert.deepEqual(agentHosts(null, null), []);
});

test("agentIdentities lists a shared key once", () => {
  const [hostA, hostBSameKey] = agentHosts(
    [ssh, access("access-d", { hostKey: hostKeyB })],
    ["access-a", "access-d"],
  );
  const identities = agentIdentities([hostA, hostBSameKey]);
  assert.equal(identities.length, 1);
  assert.ok(identities[0].keyBlob.equals(blob(keyA)));
  assert.equal(identities[0].comment, `agentpier-${hostA.keyId.slice(0, 8)}`);
});

test("agentIdentities lists distinct keys in host order", () => {
  const hosts = agentHosts([ssh, hostB], ["access-b", "access-a"]);
  assert.deepEqual(
    agentIdentities(hosts).map((identity) => identity.keyBlob.toString("base64")),
    [blob(keyB).toString("base64"), blob(keyA).toString("base64")],
  );
});
