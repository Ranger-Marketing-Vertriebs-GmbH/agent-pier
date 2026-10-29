import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey, createVerify } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import {
  publicKeyBlob,
  signatureAlgorithm,
  signUserauth,
  verifySessionBind,
} from "../../server/features/ssh/ssh-agent-keys.js";

const { utils } = ssh2;
const { sigSSHToASN1 } = createRequire(import.meta.url)("ssh2/lib/protocol/utils.js");

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ssh-agent-keys-"));
process.on("exit", () => fs.rmSync(folder, { recursive: true, force: true }));

function keyPair(type, extra = []) {
  const file = path.join(folder, `${type}-${extra.join("")}`);
  execFileSync("ssh-keygen", ["-q", "-N", "", "-t", type, ...extra, "-f", file]);
  return {
    privateText: fs.readFileSync(file, "utf8"),
    publicLine: fs.readFileSync(`${file}.pub`, "utf8").trim(),
  };
}

const ed25519 = keyPair("ed25519");
const rsa = keyPair("rsa", ["-b", "2048"]);
const ecdsa = keyPair("ecdsa", ["-b", "256"]);
const ecdsa384 = keyPair("ecdsa", ["-b", "384"]);
const ecdsa521 = keyPair("ecdsa", ["-b", "521"]);
const data = Buffer.from("userauth request bytes");

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function wireString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
}

function sshString(buffer, index) {
  let offset = 0;
  for (let current = 0; ; current += 1) {
    const length = buffer.readUInt32BE(offset);
    if (current === index) return buffer.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
  }
}

function hostSignature(pair, sessionId, algorithm, hash) {
  const key = utils.parseKey(pair.privateText);
  let signature = key.sign(sessionId, hash);
  if (algorithm.startsWith("ecdsa-")) {
    signature = sshSignatureFromDer(signature);
  }
  return Buffer.concat([wireString(algorithm), wireString(signature)]);
}

function sshSignatureFromDer(der) {
  const integers = [];
  let offset = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  while (offset < der.length) {
    const length = der[offset + 1];
    integers.push(der.subarray(offset + 2, offset + 2 + length));
    offset += 2 + length;
  }
  return Buffer.concat(integers.map(wireString));
}

test("publicKeyBlob returns the decoded blob of an OpenSSH public key line", () => {
  const blob = publicKeyBlob(ed25519.publicLine);
  assert.deepEqual(blob, Buffer.from(ed25519.publicLine.split(" ")[1], "base64"));
  assert.equal(sshString(blob, 0).toString(), "ssh-ed25519");
  assert.deepEqual(
    publicKeyBlob(`${rsa.publicLine.split(" ").slice(0, 2).join(" ")}`),
    Buffer.from(rsa.publicLine.split(" ")[1], "base64"),
  );
});

test("publicKeyBlob throws when the line type differs from the embedded type", () => {
  const [, base64] = ed25519.publicLine.split(" ");
  assert.throws(() => publicKeyBlob(`ssh-rsa ${base64}`));
  assert.throws(() => publicKeyBlob("ssh-ed25519"));
  assert.throws(() => publicKeyBlob("ssh-ed25519 !!!notbase64"));
  assert.throws(() => publicKeyBlob(`ssh-ed25519 ${base64.slice(0, 10)}`));
  assert.throws(() => publicKeyBlob(42));
});

test("ed25519 signature verifies against the public key", () => {
  const blob = signUserauth(ed25519.privateText, data, 0);
  assert.equal(sshString(blob, 0).toString(), "ssh-ed25519");
  assert.equal(utils.parseKey(ed25519.publicLine).verify(data, sshString(blob, 1)), true);
});

test("rsa uses rsa-sha2-512 for flag 4, rsa-sha2-256 for 2 and 2|4, SHA-1 only if allowed", () => {
  const publicKey = utils.parseKey(rsa.publicLine);
  const sha512 = signUserauth(rsa.privateText, data, 4);
  assert.equal(sshString(sha512, 0).toString(), "rsa-sha2-512");
  assert.equal(publicKey.verify(data, sshString(sha512, 1), "sha512"), true);
  const sha256 = signUserauth(rsa.privateText, data, 2);
  assert.equal(sshString(sha256, 0).toString(), "rsa-sha2-256");
  assert.equal(publicKey.verify(data, sshString(sha256, 1), "sha256"), true);
  assert.equal(
    sshString(signUserauth(rsa.privateText, data, 6), 0).toString(),
    "rsa-sha2-256",
    "OpenSSH tests RSA_SHA2_256 first",
  );
  assert.throws(() => signUserauth(rsa.privateText, data, 0), {
    code: "SSH_AGENT_LEGACY",
  });
  const sha1 = signUserauth(rsa.privateText, data, 0, { allowSha1: true });
  assert.equal(sshString(sha1, 0).toString(), "ssh-rsa");
  assert.equal(publicKey.verify(data, sshString(sha1, 1), "sha1"), true);
});

test("ecdsa signatures are SSH mpint pairs that verify", () => {
  for (const [pair, name, hash] of [
    [ecdsa, "ecdsa-sha2-nistp256", "sha256"],
    [ecdsa384, "ecdsa-sha2-nistp384", "sha384"],
    [ecdsa521, "ecdsa-sha2-nistp521", "sha512"],
  ]) {
    for (let round = 0; round < 8; round += 1) {
      const message = Buffer.concat([data, Buffer.from([round])]);
      const blob = signUserauth(pair.privateText, message, 0);
      assert.equal(sshString(blob, 0).toString(), name);
      const inner = sshString(blob, 1);
      const r = sshString(inner, 0);
      const s = sshString(inner, 1);
      assert.equal(8 + r.length + s.length, inner.length, "exactly two strings");
      for (const integer of [r, s]) {
        assert.ok(integer.length > 0);
        if (integer[0] === 0) assert.ok(integer[1] & 0x80, "no needless leading zero");
        else assert.equal(integer[0] & 0x80, 0, "positive mpint");
      }
      const verifier = createVerify(hash);
      verifier.update(message);
      const publicKey = createPublicKey(utils.parseKey(pair.publicLine).getPublicPEM());
      assert.equal(verifier.verify(publicKey, sigSSHToASN1(inner, name)), true);
    }
  }
});

test("session-bind verification accepts the host's signature and rejects a tampered id", () => {
  const sessionId = Buffer.alloc(32, 5);
  for (const [pair, algorithm, hash] of [
    [ed25519, "ssh-ed25519", undefined],
    [ecdsa, "ecdsa-sha2-nistp256", "sha256"],
    [ecdsa384, "ecdsa-sha2-nistp384", "sha384"],
    [ecdsa521, "ecdsa-sha2-nistp521", "sha512"],
    [rsa, "rsa-sha2-512", "sha512"],
    [rsa, "rsa-sha2-256", "sha256"],
    [rsa, "ssh-rsa", "sha1"],
  ]) {
    const hostKeyBlob = publicKeyBlob(pair.publicLine);
    const signature = hostSignature(pair, sessionId, algorithm, hash);
    assert.equal(
      verifySessionBind({ hostKeyBlob, sessionId, signature }),
      algorithm,
      "returns the bind signature's algorithm",
    );
    assert.equal(
      verifySessionBind({ hostKeyBlob, sessionId: Buffer.from("x"), signature }),
      false,
    );
  }
});

test("session-bind verification fails for a foreign key, a wrong algorithm or garbage", () => {
  const sessionId = Buffer.alloc(32, 6);
  const signature = hostSignature(ed25519, sessionId, "ssh-ed25519");
  const other = publicKeyBlob(keyPair("ed25519", ["-C", "other"]).publicLine);
  assert.equal(verifySessionBind({ hostKeyBlob: other, sessionId, signature }), false);
  const hostKeyBlob = publicKeyBlob(ed25519.publicLine);
  const renamed = Buffer.concat([
    wireString("ssh-rsa"),
    wireString(sshString(signature, 1)),
  ]);
  assert.equal(verifySessionBind({ hostKeyBlob, sessionId, signature: renamed }), false);
  const rsaBlob = publicKeyBlob(rsa.publicLine);
  const rsaSig = hostSignature(rsa, sessionId, "rsa-sha2-512", "sha512");
  const mislabelled = Buffer.concat([
    wireString("rsa-sha2-256"),
    wireString(sshString(rsaSig, 1)),
  ]);
  assert.equal(
    verifySessionBind({ hostKeyBlob: rsaBlob, sessionId, signature: mislabelled }),
    false,
  );
  const padded = Buffer.concat([signature, Buffer.from([0])]);
  assert.equal(verifySessionBind({ hostKeyBlob, sessionId, signature: padded }), false);
  assert.equal(
    verifySessionBind({ hostKeyBlob: Buffer.from("junk"), sessionId, signature }),
    false,
  );
  assert.equal(
    verifySessionBind({ hostKeyBlob, sessionId, signature: Buffer.from([0, 0, 0, 99]) }),
    false,
  );
  assert.equal(verifySessionBind({}), false);
});

test("an unparsable key is unsupported", () => {
  assert.throws(() => signUserauth("garbage", data, 0), {
    code: "SSH_AGENT_KEY_UNSUPPORTED",
  });
  assert.throws(() => signUserauth(ed25519.publicLine, data, 0), {
    code: "SSH_AGENT_KEY_UNSUPPORTED",
  });
});

test("an encrypted key is unsupported and its error carries no key text", () => {
  const file = path.join(folder, "encrypted");
  execFileSync("ssh-keygen", ["-q", "-N", "secret-pass", "-t", "ed25519", "-f", file]);
  const text = fs.readFileSync(file, "utf8");
  assert.throws(
    () => signUserauth(text, data, 0),
    (error) =>
      error.code === "SSH_AGENT_KEY_UNSUPPORTED" &&
      !String(error.message).includes("PRIVATE KEY") &&
      error.cause === undefined,
  );
});

test("signatureAlgorithm follows OpenSSH flag order and the legacy switch", () => {
  assert.equal(signatureAlgorithm("ssh-rsa", 2), "rsa-sha2-256");
  assert.equal(signatureAlgorithm("ssh-rsa", 4), "rsa-sha2-512");
  assert.equal(signatureAlgorithm("ssh-rsa", 6), "rsa-sha2-256");
  assert.equal(signatureAlgorithm("ssh-rsa", 0, { allowSha1: true }), "ssh-rsa");
  assert.throws(() => signatureAlgorithm("ssh-rsa", 8), { code: "SSH_AGENT_LEGACY" });
  assert.equal(signatureAlgorithm("ssh-ed25519", 4), "ssh-ed25519");
  assert.equal(signatureAlgorithm("ecdsa-sha2-nistp521", 2), "ecdsa-sha2-nistp521");
  assert.throws(() => signatureAlgorithm("ssh-dss", 0), {
    code: "SSH_AGENT_KEY_UNSUPPORTED",
  });
});

test("non-RSA keys ignore RSA flags", () => {
  assert.equal(
    sshString(signUserauth(ecdsa.privateText, data, 4), 0).toString(),
    "ecdsa-sha2-nistp256",
  );
  assert.equal(
    sshString(signUserauth(ed25519.privateText, data, 2), 0).toString(),
    "ssh-ed25519",
  );
});

function blobLine(type, body) {
  return `${type} ${Buffer.concat([wireString(type), body]).toString("base64")}`;
}

test("publicKeyBlob refuses DSS, certificates, unknown types and malformed bodies", () => {
  for (const type of [
    "ssh-dss",
    "ssh-ed25519-cert-v01@openssh.com",
    "ecdsa-sha2-nistp256-cert-v01@openssh.com",
    "bogus-type",
  ]) {
    assert.throws(() => publicKeyBlob(blobLine(type, wireString(Buffer.alloc(32, 1)))), {
      code: "SSH_AGENT_KEY_UNSUPPORTED",
    });
  }
  assert.throws(() => publicKeyBlob(blobLine("ssh-ed25519", Buffer.alloc(3, 1))), {
    code: "SSH_AGENT_KEY_UNSUPPORTED",
  });
  const blob = publicKeyBlob(ed25519.publicLine);
  const trailing = Buffer.concat([blob, Buffer.from([0])]).toString("base64");
  assert.throws(() => publicKeyBlob(`ssh-ed25519 ${trailing}`), {
    code: "SSH_AGENT_KEY_UNSUPPORTED",
  });
});

test("session-bind refuses a host key blob that is not canonical", () => {
  const sessionId = Buffer.alloc(32, 8);
  for (const [pair, algorithm, hash] of [
    [ed25519, "ssh-ed25519", undefined],
    [ecdsa384, "ecdsa-sha2-nistp384", "sha384"],
    [ecdsa521, "ecdsa-sha2-nistp521", "sha512"],
    [rsa, "rsa-sha2-256", "sha256"],
  ]) {
    const hostKeyBlob = Buffer.concat([publicKeyBlob(pair.publicLine), Buffer.from([7])]);
    const signature = hostSignature(pair, sessionId, algorithm, hash);
    assert.equal(verifySessionBind({ hostKeyBlob, sessionId, signature }), false);
  }
});

test("session-bind refuses ECDSA signatures with trailing or non-canonical integers", () => {
  const sessionId = Buffer.alloc(32, 4);
  for (const [pair, name, hash] of [
    [ecdsa, "ecdsa-sha2-nistp256", "sha256"],
    [ecdsa384, "ecdsa-sha2-nistp384", "sha384"],
    [ecdsa521, "ecdsa-sha2-nistp521", "sha512"],
  ]) {
    const hostKeyBlob = publicKeyBlob(pair.publicLine);
    const good = hostSignature(pair, sessionId, name, hash);
    assert.equal(verifySessionBind({ hostKeyBlob, sessionId, signature: good }), name);
    const inner = sshString(good, 1);
    const r = sshString(inner, 0);
    const s = sshString(inner, 1);
    const wrap = (body) => Buffer.concat([wireString(name), wireString(body)]);
    const variants = [
      Buffer.concat([inner, Buffer.from([1, 2, 3])]),
      Buffer.concat([wireString(Buffer.concat([Buffer.from([0]), r])), wireString(s)]),
      Buffer.concat([wireString(r), wireString(Buffer.concat([Buffer.from([0, 0]), s]))]),
      Buffer.concat([wireString(Buffer.alloc(0)), wireString(s)]),
      Buffer.concat([wireString(Buffer.concat([Buffer.from([0x80]), r])), wireString(s)]),
      wireString(r),
    ];
    for (const body of variants) {
      assert.equal(
        verifySessionBind({ hostKeyBlob, sessionId, signature: wrap(body) }),
        false,
      );
    }
  }
});
