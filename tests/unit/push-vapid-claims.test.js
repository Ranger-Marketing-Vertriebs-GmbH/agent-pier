import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createECDH, randomBytes } from "node:crypto";
import {
  createPushSender,
  vapidSubject,
} from "../../server/features/notifications/push-sender.js";
import {
  pushFailureText,
  pushRefusalReason,
} from "../../server/features/notifications/push-failure.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";
import {
  createMessageIndex,
  resolveMessage,
} from "../../server/lib/i18n/message-keys.js";

const payload = {
  v: 2,
  kind: "test",
  eventId: "event-1",
  link: "/settings/notifications",
  tag: "event-1",
};

function material(endpoint) {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const vapidKey = createECDH("prime256v1");
  vapidKey.generateKeys();
  return {
    subscription: {
      endpoint,
      keys: {
        p256dh: receiver.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
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

// Records the prepared request instead of opening a socket; the push service answers
// with `status` and `body`.
function capture(status = 201, body = "") {
  const requests = [];
  const send = createPushSender({
    request(endpoint, options, callback) {
      const outgoing = new EventEmitter();
      outgoing.destroy = (error) => outgoing.emit("error", error);
      outgoing.end = (data) => {
        requests.push({ endpoint, headers: options.headers, body: data });
        const incoming = new PassThrough();
        incoming.statusCode = status;
        callback(incoming);
        incoming.end(body);
        setImmediate(() => outgoing.emit("close"));
      };
      return outgoing;
    },
  });
  return { send, requests };
}

function claims(authorization, publicKey) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  assert.ok(match, "VAPID authorization scheme");
  assert.equal(match[2], publicKey);
  const [head, body] = match[1].split(".");
  assert.equal(JSON.parse(Buffer.from(head, "base64url")).alg, "ES256");
  return JSON.parse(Buffer.from(body, "base64url"));
}

test("VAPID JWT carries a public https subject, the endpoint origin and a sub-day expiry", async () => {
  for (const endpoint of [
    "https://web.push.apple.com/QGuZ-opaque-device-token",
    "https://fcm.googleapis.com/fcm/send/opaque-token",
  ]) {
    const { send, requests } = capture();
    const { subscription, vapid } = material(endpoint);
    const before = Math.floor(Date.now() / 1000);
    assert.deepEqual(await send(subscription, payload, vapid), { statusCode: 201 });
    const after = Math.ceil(Date.now() / 1000);
    const [request] = requests;
    const jwt = claims(request.headers.Authorization, vapid.publicKey);
    assert.equal(jwt.sub, vapidSubject);
    const subject = new URL(jwt.sub);
    assert.equal(subject.protocol, "https:");
    assert.doesNotMatch(subject.hostname, /(^|\.)(localhost|local|invalid|internal)$/);
    assert.match(subject.hostname, /\.[a-z]{2,}$/);
    assert.equal(jwt.aud, new URL(endpoint).origin);
    // Apple: "The JWT expiration parameter is more than one day into the future" fails.
    assert.ok(jwt.exp > after, "JWT is not yet expired");
    assert.ok(jwt.exp <= before + 24 * 60 * 60, "JWT expires within one day");
    assert.equal(request.headers.TTL, 300);
    assert.equal(request.headers.Urgency, "normal");
    assert.equal(request.headers.Topic, undefined);
    assert.equal(request.headers["Content-Encoding"], "aes128gcm");
    assert.ok(request.body.length <= 4096, "Apple payload limit of 4 KB");
  }
});

test("a stored VAPID keypair cannot override the subject", async () => {
  const { send, requests } = capture();
  const { subscription, vapid } = material("https://web.push.apple.com/QGuZ-token");
  await send(subscription, payload, { ...vapid, subject: "mailto:agentpier@localhost" });
  assert.equal(
    claims(requests[0].headers.Authorization, vapid.publicKey).sub,
    vapidSubject,
  );
});

test("refusals keep the push service's short reason", async () => {
  const apple = capture(403, '{"reason":"BadJwtToken"}');
  const { subscription, vapid } = material("https://web.push.apple.com/QGuZ-token");
  await assert.rejects(apple.send(subscription, payload, vapid), {
    statusCode: 403,
    reason: "BadJwtToken",
  });
  const fcm = capture(400, "UnauthorizedRegistration\n");
  await assert.rejects(fcm.send(subscription, payload, vapid), {
    statusCode: 400,
    reason: "UnauthorizedRegistration",
  });
  const silent = capture(500, "");
  await assert.rejects(silent.send(subscription, payload, vapid), (error) => {
    assert.equal(error.statusCode, 500);
    assert.equal(error.reason, undefined);
    return true;
  });
});

test("refusal reasons are sanitized and length-limited", () => {
  assert.equal(
    pushRefusalReason('{"reason":"VapidPkHashMismatch"}'),
    "VapidPkHashMismatch",
  );
  assert.equal(
    pushRefusalReason('{"code":410,"errno":106,"error":"Gone","message":"Expired"}'),
    "Expired",
  );
  assert.equal(pushRefusalReason(""), undefined);
  assert.equal(pushRefusalReason(" \n\t "), undefined);
  const token = "A".repeat(64);
  const leaked = pushRefusalReason(
    `Invalid token ${token} for https://web.push.apple.com/secret-path\u0007 done`,
  );
  assert.equal(leaked, "Invalid token [redacted] for [url] done");
  assert.ok(pushRefusalReason("x ".repeat(500)).length <= 160);
});

test("failure texts translate known reasons and keep the generic message otherwise", () => {
  const de = serverCatalogs.de.notifications;
  assert.equal(pushFailureText(Error("offline")), de.deliveryFailed);
  assert.equal(
    pushFailureText({ statusCode: 403, reason: "BadJwtToken" }),
    de.refusedSignature("403 BadJwtToken"),
  );
  assert.equal(
    pushFailureText({ statusCode: 403, reason: "ExpiredJwtToken" }),
    de.refusedExpiredSignature("403 ExpiredJwtToken"),
  );
  assert.equal(
    pushFailureText({ statusCode: 400, reason: "VapidPkHashMismatch" }),
    de.refusedKey("400 VapidPkHashMismatch"),
  );
  assert.equal(
    pushFailureText({ statusCode: 429, reason: "TooManyRequests" }),
    de.refusedRateLimit("429 TooManyRequests"),
  );
  assert.equal(pushFailureText({ statusCode: 429 }), de.refusedRateLimit("HTTP 429"));
  assert.equal(
    pushFailureText({ statusCode: 400, reason: "Something new" }),
    de.deliveryFailedWithReason("HTTP 400: Something new"),
  );
  assert.equal(
    pushFailureText({ statusCode: 400, reason: "toString" }),
    de.deliveryFailedWithReason("HTTP 400: toString"),
  );
  assert.equal(
    pushFailureText({ statusCode: 502 }),
    de.deliveryFailedWithReason("HTTP 502"),
  );
});

test("stored failure texts resolve to English through the German catalog index", () => {
  const identify = createMessageIndex(serverCatalogs.de);
  const english = (text) => {
    const found = identify(text);
    assert.ok(found, text);
    return resolveMessage(serverCatalogs.en, found.key, found.args);
  };
  assert.equal(
    english(pushFailureText({ statusCode: 403, reason: "BadJwtToken" })),
    "The push service rejected the sender identification (403 BadJwtToken). Update AgentPier and send a test notification.",
  );
  assert.equal(
    english(pushFailureText({ statusCode: 400, reason: "Something new" })),
    "Delivery failed (HTTP 400: Something new). Try a test notification.",
  );
  assert.equal(
    english(pushFailureText(Error("offline"))),
    "Delivery failed. Try a test notification.",
  );
});
