// Wire codec for the SSH agent protocol (draft-miller-ssh-agent). Every length is
// checked against the bytes actually present; nothing here logs or keeps payloads.

export const agentMessage = Object.freeze({
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

export const signFlags = Object.freeze({ RSA_SHA2_256: 2, RSA_SHA2_512: 4 });

const sessionBindExtension = "session-bind@openssh.com";
const userauthRequest = 50;
const publickeyMethods = new Set(["publickey", "publickey-hostbound-v00@openssh.com"]);
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Collects chunks in a list and joins them once per complete frame, so a frame sent
// in tiny writes costs linear time. Chunks are copied on arrival.
export class AgentFrameReader {
  constructor({ maxMessage = 262144 } = {}) {
    this.maxMessage = maxMessage;
    this.chunks = [];
    this.size = 0;
    this.expected = null;
  }

  take(count) {
    let joined = this.chunks[0];
    if (joined.length < count) {
      let used = 0;
      let length = 0;
      while (length < count) length += this.chunks[used++].length;
      joined = Buffer.concat(this.chunks.splice(0, used, Buffer.alloc(0)), length);
      this.chunks[0] = joined;
    }
    const taken = joined.subarray(0, count);
    if (joined.length === count) this.chunks.shift();
    else this.chunks[0] = joined.subarray(count);
    this.size -= count;
    return taken;
  }

  push(chunk) {
    if (chunk.length) {
      this.chunks.push(Buffer.from(chunk));
      this.size += chunk.length;
    }
    const frames = [];
    for (;;) {
      if (this.expected === null) {
        if (this.size < 4) break;
        const length = this.take(4).readUInt32BE(0);
        if (length === 0 || length > this.maxMessage) {
          this.chunks = [];
          this.size = 0;
          throw codedError("SSH_AGENT_FRAME", "SSH agent frame length out of range");
        }
        this.expected = length;
      }
      if (this.size < this.expected) break;
      frames.push(this.take(this.expected));
      this.expected = null;
    }
    return frames;
  }
}

export function encodeFrame(payload) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

export class WireReader {
  constructor(buffer, offset = 0) {
    this.buffer = buffer;
    this.offset = offset;
  }

  byte() {
    if (this.offset + 1 > this.buffer.length) return undefined;
    return this.buffer[this.offset++];
  }

  u32() {
    if (this.offset + 4 > this.buffer.length) return undefined;
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  string() {
    const length = this.u32();
    if (length === undefined || length > this.buffer.length - this.offset)
      return undefined;
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  text() {
    const bytes = this.string();
    if (bytes === undefined) return undefined;
    try {
      return strictUtf8.decode(bytes);
    } catch {
      return undefined;
    }
  }

  get done() {
    return this.offset === this.buffer.length;
  }
}

function malformed() {
  return codedError("SSH_AGENT_MALFORMED", "Malformed SSH agent request");
}

function required(value) {
  if (value === undefined) throw malformed();
  return value;
}

function copy(bytes) {
  return Buffer.from(bytes);
}

function parseExtension(reader) {
  const nameBytes = required(reader.string());
  if (nameBytes.length > 255 || !/^[\x21-\x7e]+$/.test(nameBytes.toString("latin1")))
    throw malformed();
  const name = nameBytes.toString("latin1");
  if (name !== sessionBindExtension) return { kind: "extension", name };
  const hostKeyBlob = copy(required(reader.string()));
  const sessionId = copy(required(reader.string()));
  const signature = copy(required(reader.string()));
  const forwarding = required(reader.byte());
  if (!reader.done) throw malformed();
  return {
    kind: "session-bind",
    hostKeyBlob,
    sessionId,
    signature,
    forwarding: forwarding !== 0,
  };
}

export function parseAgentRequest(message) {
  if (!Buffer.isBuffer(message) || message.length === 0) throw malformed();
  const reader = new WireReader(message, 1);
  const type = message[0];
  if (type === agentMessage.REQUEST_IDENTITIES) {
    if (!reader.done) throw malformed();
    return { kind: "identities" };
  }
  if (type === agentMessage.SIGN_REQUEST) {
    const keyBlob = copy(required(reader.string()));
    const data = copy(required(reader.string()));
    const flags = required(reader.u32());
    if (!reader.done) throw malformed();
    return { kind: "sign", keyBlob, data, flags };
  }
  if (type === agentMessage.EXTENSION) return parseExtension(reader);
  return { kind: "unsupported", type };
}

export function parseUserauthRequest(data) {
  if (!Buffer.isBuffer(data)) return null;
  const reader = new WireReader(data);
  const sessionId = reader.string();
  if (sessionId === undefined || reader.byte() !== userauthRequest) return null;
  const user = reader.text();
  const service = reader.text();
  const method = reader.text();
  if (user === undefined || service === undefined || !publickeyMethods.has(method))
    return null;
  if (reader.byte() !== 1) return null;
  const algorithm = reader.text();
  const keyBlob = reader.string();
  if (algorithm === undefined || keyBlob === undefined) return null;
  let hostKeyBlob = null;
  if (method !== "publickey") {
    hostKeyBlob = reader.string();
    if (hostKeyBlob === undefined) return null;
    hostKeyBlob = copy(hostKeyBlob);
  }
  if (!reader.done) return null;
  return {
    sessionId: copy(sessionId),
    user,
    service,
    method,
    algorithm,
    keyBlob: copy(keyBlob),
    hostKeyBlob,
  };
}

function wireU32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

export function wireString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return Buffer.concat([wireU32(bytes.length), bytes]);
}

function single(type) {
  return encodeFrame(Buffer.from([type]));
}

export const agentReply = Object.freeze({
  failure: () => single(agentMessage.FAILURE),
  success: () => single(agentMessage.SUCCESS),
  extensionFailure: () => single(agentMessage.EXTENSION_FAILURE),
  identities: (list) =>
    encodeFrame(
      Buffer.concat([
        Buffer.from([agentMessage.IDENTITIES_ANSWER]),
        wireU32(list.length),
        ...list.flatMap(({ keyBlob, comment }) => [
          wireString(keyBlob),
          wireString(comment),
        ]),
      ]),
    ),
  signature: (blob) =>
    encodeFrame(
      Buffer.concat([Buffer.from([agentMessage.SIGN_RESPONSE]), wireString(blob)]),
    ),
});
