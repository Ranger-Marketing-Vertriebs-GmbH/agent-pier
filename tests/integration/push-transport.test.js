import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createECDH,
  createDecipheriv,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import { createPushSender } from "../../server/features/notifications/push-sender.js";
import { pushLookup } from "../../server/features/notifications/push-network.js";

let directory;
let tls;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agentpier-push-transport-"));
  const key = path.join(directory, "key.pem");
  const cert = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=push.example.org",
    ],
    { stdio: "ignore" },
  );
  tls = { key: await readFile(key), cert: await readFile(cert) };
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function keys() {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const auth = randomBytes(16);
  const vapidKey = createECDH("prime256v1");
  vapidKey.generateKeys();
  return {
    receiver,
    auth,
    subscription: {
      endpoint: "https://push.example.org/opaque-target",
      keys: {
        p256dh: receiver.getPublicKey().toString("base64url"),
        auth: auth.toString("base64url"),
      },
    },
    vapid: {
      publicKey: vapidKey.getPublicKey().toString("base64url"),
      privateKey: Buffer.from(
        vapidKey.getPrivateKey("hex").padStart(64, "0"),
        "hex",
      ).toString("base64url"),
    },
  };
}
const payload = { kind: "permission", eventId: "request-123", sessionId: "session-1" };

async function fixture(t, handler) {
  let calls = 0;
  const sockets = new Set();
  const server = https.createServer(tls, handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Inject only the network destination; production serialization, crypto and TLS run.
  const send = createPushSender({
    request(endpoint, options, callback) {
      calls++;
      assert.equal(endpoint, "https://push.example.org/opaque-target");
      assert.equal(options.lookup, pushLookup);
      assert.equal(options.agent, false);
      return https.request(
        {
          ...options,
          hostname: "127.0.0.1",
          port: server.address().port,
          path: new URL(endpoint).pathname,
          servername: "push.example.org",
          ca: tls.cert,
        },
        callback,
      );
    },
  });
  t.after(async () => {
    send.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { send, calls: () => calls };
}

// RFC 8291 / RFC 8188 decoding uses Node primitives independently of web-push.
function decrypt(body, receiver, auth) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body[20];
  assert.equal(idLength, 65);
  const senderPublic = body.subarray(21, 21 + idLength);
  const shared = receiver.computeSecret(senderPublic);
  const info = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    receiver.getPublicKey(),
    senderPublic,
  ]);
  const ikm = hkdfSync("sha256", shared, auth, info, 32);
  const key = hkdfSync(
    "sha256",
    ikm,
    salt,
    Buffer.from("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = hkdfSync(
    "sha256",
    ikm,
    salt,
    Buffer.from("Content-Encoding: nonce\0"),
    12,
  );
  const ciphertext = body.subarray(21 + idLength);
  assert.ok(ciphertext.length <= recordSize);
  const cipher = createDecipheriv("aes-128-gcm", key, nonce);
  cipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([
    cipher.update(ciphertext.subarray(0, -16)),
    cipher.final(),
  ]);
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  assert.equal(plain[end], 2, "final record delimiter");
  return JSON.parse(plain.subarray(0, end).toString());
}

function checkVapid(header, publicKey) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(match);
  assert.equal(match[2], publicKey);
  const [head, body, signature] = match[1].split(".");
  assert.equal(JSON.parse(Buffer.from(head, "base64url")).alg, "ES256");
  const claims = JSON.parse(Buffer.from(body, "base64url"));
  assert.equal(claims.aud, "https://push.example.org");
  assert.equal(claims.sub, "mailto:agentpier@localhost");
  const now = Date.now() / 1000;
  assert.ok(claims.exp > now && claims.exp <= now + 86401);
  const raw = Buffer.from(publicKey, "base64url");
  const key = createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33).toString("base64url"),
    },
  });
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${head}.${body}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  );
}

test("real HTTPS encrypted push independently decrypts and verifies VAPID without content leakage", async (t) => {
  const material = keys();
  const deliveries = [];
  const { send, calls } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    deliveries.push({
      headers: req.headers,
      method: req.method,
      url: req.url,
      body: Buffer.concat(chunks),
    });
    res.writeHead(201).end();
  });
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(
      await send(
        material.subscription,
        {
          ...payload,
          prompt: "SECRET PROMPT",
          answer: "SECRET ANSWER",
          token: "SECRET TOKEN",
        },
        material.vapid,
      ),
      { statusCode: 201 },
    );
  }
  assert.equal(calls(), 2);
  for (const delivery of deliveries) {
    assert.equal(delivery.method, "POST");
    assert.equal(delivery.url, "/opaque-target");
    assert.equal(delivery.headers["content-encoding"], "aes128gcm");
    assert.equal(delivery.headers.ttl, "300");
    assert.equal(Number(delivery.headers["content-length"]), delivery.body.length);
    assert.equal(delivery.body.includes(Buffer.from(payload.eventId)), false);
    assert.deepEqual(decrypt(delivery.body, material.receiver, material.auth), payload);
    checkVapid(delivery.headers.authorization, material.vapid.publicKey);
  }
  assert.notDeepEqual(
    deliveries[0].body,
    deliveries[1].body,
    "fresh salt and ephemeral encryption key per delivery",
  );
});

test("push refuses redirects without a second HTTPS request", async (t) => {
  const material = keys();
  const { send, calls } = await fixture(t, (_req, res) =>
    res.writeHead(307, { location: "https://other.example.org/exfiltrate" }).end(),
  );
  await assert.rejects(send(material.subscription, payload, material.vapid), {
    statusCode: 307,
  });
  assert.equal(calls(), 1);
});

test("push aborts response bodies above 64 KiB", async (t) => {
  const material = keys();
  const { send } = await fixture(t, (_req, res) =>
    res.writeHead(201).end(Buffer.alloc(65537)),
  );
  await assert.rejects(
    send(material.subscription, payload, material.vapid),
    /exceeded its limit/,
  );
});

test(
  "push total timeout aborts a server that never sends response headers",
  { timeout: 15000 },
  async (t) => {
    const material = keys();
    const { send } = await fixture(t, () => {});
    const started = Date.now();
    await assert.rejects(
      send(material.subscription, payload, material.vapid),
      /timed out/,
    );
    assert.ok(Date.now() - started < 14000);
  },
);

test("closing push sender rejects an in-flight HTTPS exchange", async (t) => {
  const material = keys();
  let arrived;
  const received = new Promise((resolve) => {
    arrived = resolve;
  });
  const { send } = await fixture(t, () => arrived());
  const pending = send(material.subscription, payload, material.vapid);
  const rejection = assert.rejects(pending, /sender closed/);
  await received;
  send.close();
  await rejection;
});

test("invalid subscription and payload are rejected before any transport call", async () => {
  const material = keys();
  let calls = 0;
  const send = createPushSender({
    request() {
      calls++;
      throw Error("unexpected network");
    },
  });
  for (const endpoint of [
    "http://push.example.org/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://push.local/x",
    "https://user:pass@push.example.org/x",
    "https://push.example.org:8443/x",
  ]) {
    await assert.rejects(
      send({ ...material.subscription, endpoint }, payload, material.vapid),
    );
  }
  await assert.rejects(
    send(
      {
        ...material.subscription,
        keys: {
          ...material.subscription.keys,
          p256dh: Buffer.alloc(65).toString("base64url"),
        },
      },
      payload,
      material.vapid,
    ),
  );
  await assert.rejects(
    send(material.subscription, { ...payload, eventId: "../secret" }, material.vapid),
  );
  assert.equal(calls, 0);
});
