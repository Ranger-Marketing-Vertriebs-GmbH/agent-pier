import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentFrameReader,
  agentMessage,
  agentReply,
  encodeFrame,
  parseAgentRequest,
  parseUserauthRequest,
  signFlags,
} from "../../server/features/ssh/ssh-agent-protocol.js";

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
}

const hostKey = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 7))]);
const userKey = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 9))]);
const sessionId = Buffer.alloc(32, 3);

function bindMessage({ forwarding = false, trailing = Buffer.alloc(0) } = {}) {
  return Buffer.concat([
    Buffer.from([agentMessage.EXTENSION]),
    sshString("session-bind@openssh.com"),
    sshString(hostKey),
    sshString(sessionId),
    sshString(Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(64, 1))])),
    Buffer.from([forwarding ? 1 : 0]),
    trailing,
  ]);
}

function userauth({
  method = "publickey",
  service = "ssh-connection",
  user = "deploy",
  hasSignature = true,
  hostKey: boundKey = null,
} = {}) {
  return Buffer.concat([
    sshString(sessionId),
    Buffer.from([50]),
    sshString(user),
    sshString(service),
    sshString(method),
    Buffer.from([hasSignature ? 1 : 0]),
    sshString("ssh-ed25519"),
    sshString(userKey),
    ...(boundKey ? [sshString(boundKey)] : []),
  ]);
}

function signRequest(flags = 0, trailing = Buffer.alloc(0)) {
  return Buffer.concat([
    Buffer.from([agentMessage.SIGN_REQUEST]),
    sshString(userKey),
    sshString(userauth()),
    u32(flags),
    trailing,
  ]);
}

test("message numbers and sign flags follow the agent protocol", () => {
  assert.deepEqual(agentMessage, {
    FAILURE: 5,
    SUCCESS: 6,
    REQUEST_IDENTITIES: 11,
    IDENTITIES_ANSWER: 12,
    SIGN_REQUEST: 13,
    SIGN_RESPONSE: 14,
    ADD_IDENTITY: 17,
    EXTENSION: 27,
    EXTENSION_FAILURE: 28,
  });
  assert.deepEqual(signFlags, { RSA_SHA2_256: 2, RSA_SHA2_512: 4 });
});

test("frames split over chunks are reassembled", () => {
  const reader = new AgentFrameReader();
  const bytes = encodeFrame(Buffer.from([agentMessage.REQUEST_IDENTITIES]));
  assert.deepEqual(reader.push(bytes.subarray(0, 3)), []);
  assert.deepEqual(reader.push(bytes.subarray(3)), [Buffer.from([11])]);
});

test("several frames in one chunk and a frame split byte by byte are all returned", () => {
  const reader = new AgentFrameReader();
  const one = encodeFrame(Buffer.from([11]));
  const two = encodeFrame(signRequest());
  assert.deepEqual(reader.push(Buffer.concat([one, two])), [
    Buffer.from([11]),
    signRequest(),
  ]);
  const frames = [];
  for (const byte of two) frames.push(...reader.push(Buffer.from([byte])));
  assert.deepEqual(frames, [signRequest()]);
});

test("an oversized frame is refused", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(262145);
  assert.throws(() => new AgentFrameReader().push(header), { code: "SSH_AGENT_FRAME" });
});

test("a frame of exactly the limit is accepted and a custom limit applies", () => {
  const payload = Buffer.alloc(262144, 11);
  assert.deepEqual(new AgentFrameReader().push(encodeFrame(payload)), [payload]);
  assert.throws(() => new AgentFrameReader({ maxMessage: 8 }).push(u32(9)), {
    code: "SSH_AGENT_FRAME",
  });
});

test("a zero-length frame is refused", () => {
  assert.throws(() => new AgentFrameReader().push(u32(0)), { code: "SSH_AGENT_FRAME" });
});

test("encodeFrame prefixes the payload length", () => {
  assert.deepEqual(
    encodeFrame(Buffer.from([1, 2, 3])),
    Buffer.from([0, 0, 0, 3, 1, 2, 3]),
  );
});

test("request-identities is parsed and refuses trailing bytes", () => {
  assert.deepEqual(parseAgentRequest(Buffer.from([11])), { kind: "identities" });
  assert.throws(() => parseAgentRequest(Buffer.from([11, 0])), {
    code: "SSH_AGENT_MALFORMED",
  });
});

test("sign requests carry key, data and flags", () => {
  const request = parseAgentRequest(signRequest(signFlags.RSA_SHA2_512));
  assert.equal(request.kind, "sign");
  assert.deepEqual(request.keyBlob, userKey);
  assert.deepEqual(request.data, userauth());
  assert.equal(request.flags, 4);
});

test("truncated or padded sign requests are malformed", () => {
  const full = signRequest();
  for (const cut of [1, 3, 5, 20, full.length - 1]) {
    assert.throws(() => parseAgentRequest(full.subarray(0, cut)), {
      code: "SSH_AGENT_MALFORMED",
    });
  }
  assert.throws(() => parseAgentRequest(signRequest(0, Buffer.from([0]))), {
    code: "SSH_AGENT_MALFORMED",
  });
  const lying = Buffer.concat([Buffer.from([13]), u32(0xffffffff), Buffer.alloc(8)]);
  assert.throws(() => parseAgentRequest(lying), { code: "SSH_AGENT_MALFORMED" });
  assert.throws(() => parseAgentRequest(Buffer.alloc(0)), {
    code: "SSH_AGENT_MALFORMED",
  });
});

test("session-bind is parsed with its forwarding flag", () => {
  const request = parseAgentRequest(bindMessage({ forwarding: true }));
  assert.equal(request.kind, "session-bind");
  assert.equal(request.forwarding, true);
  const plain = parseAgentRequest(bindMessage());
  assert.equal(plain.forwarding, false);
  assert.deepEqual(plain.hostKeyBlob, hostKey);
  assert.deepEqual(plain.sessionId, sessionId);
  assert.equal(
    plain.signature.subarray(4, 15).toString(),
    "ssh-ed25519",
    "signature stays the raw SSH signature blob",
  );
});

test("session-bind with trailing or missing bytes is malformed", () => {
  assert.throws(() => parseAgentRequest(bindMessage({ trailing: Buffer.from([0]) })), {
    code: "SSH_AGENT_MALFORMED",
  });
  const full = bindMessage();
  assert.throws(() => parseAgentRequest(full.subarray(0, full.length - 1)), {
    code: "SSH_AGENT_MALFORMED",
  });
});

test("other extensions report their name", () => {
  const message = Buffer.concat([
    Buffer.from([27]),
    sshString("query"),
    Buffer.from("anything"),
  ]);
  assert.deepEqual(parseAgentRequest(message), { kind: "extension", name: "query" });
  const binary = Buffer.concat([Buffer.from([27]), sshString(Buffer.from([0, 10]))]);
  assert.throws(() => parseAgentRequest(binary), { code: "SSH_AGENT_MALFORMED" });
});

test("add-identity is reported as unsupported", () => {
  assert.deepEqual(parseAgentRequest(Buffer.from([17, 0, 0, 0, 0])), {
    kind: "unsupported",
    type: 17,
  });
});

test("userauth data for publickey and hostbound methods parse; others are null", () => {
  const plain = parseUserauthRequest(userauth({ method: "publickey" }));
  assert.equal(plain.user, "deploy");
  assert.equal(plain.service, "ssh-connection");
  assert.equal(plain.method, "publickey");
  assert.equal(plain.algorithm, "ssh-ed25519");
  assert.deepEqual(plain.sessionId, sessionId);
  assert.deepEqual(plain.keyBlob, userKey);
  assert.equal(plain.hostKeyBlob, null);
  assert.deepEqual(
    parseUserauthRequest(
      userauth({ method: "publickey-hostbound-v00@openssh.com", hostKey }),
    ).hostKeyBlob,
    hostKey,
  );
  assert.equal(parseUserauthRequest(Buffer.from("not userauth")), null);
  assert.equal(
    parseUserauthRequest(Buffer.concat([userauth({}), Buffer.from([0])])),
    null,
  );
});

test("userauth data without signature, other methods or bad bytes is null", () => {
  assert.equal(parseUserauthRequest(userauth({ hasSignature: false })), null);
  assert.equal(parseUserauthRequest(userauth({ method: "password" })), null);
  assert.equal(
    parseUserauthRequest(userauth({ method: "publickey-hostbound-v00@openssh.com" })),
    null,
    "hostbound needs the host key",
  );
  const full = userauth();
  assert.equal(parseUserauthRequest(full.subarray(0, full.length - 1)), null);
  const wrongType = Buffer.from(full);
  wrongType[4 + sessionId.length] = 51;
  assert.equal(parseUserauthRequest(wrongType), null);
  assert.equal(parseUserauthRequest(userauth({ user: Buffer.from([0xff, 0xfe]) })), null);
  assert.equal(parseUserauthRequest(Buffer.alloc(0)), null);
});

test("replies are framed agent messages", () => {
  assert.deepEqual(agentReply.failure(), Buffer.from([0, 0, 0, 1, 5]));
  assert.deepEqual(agentReply.success(), Buffer.from([0, 0, 0, 1, 6]));
  assert.deepEqual(agentReply.extensionFailure(), Buffer.from([0, 0, 0, 1, 28]));
  assert.deepEqual(
    agentReply.signature(Buffer.from([1, 2])),
    encodeFrame(Buffer.concat([Buffer.from([14]), sshString(Buffer.from([1, 2]))])),
  );
  assert.deepEqual(
    agentReply.identities([{ keyBlob: userKey, comment: "agentpier-1234abcd" }]),
    encodeFrame(
      Buffer.concat([
        Buffer.from([12]),
        u32(1),
        sshString(userKey),
        sshString("agentpier-1234abcd"),
      ]),
    ),
  );
  assert.deepEqual(agentReply.identities([]), encodeFrame(Buffer.from([12, 0, 0, 0, 0])));
});

test("an identities reply round-trips through the frame reader", () => {
  const frames = new AgentFrameReader().push(
    agentReply.identities([{ keyBlob: hostKey, comment: "a" }]),
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0][0], agentMessage.IDENTITIES_ANSWER);
});
