import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import { AuthThrottle, hookEndpoint } from "../../server/http/hook-endpoint.js";
import { deliveries, hookFixture } from "../helpers/agent-hook-fixture.js";

const remoteHost = "agentpier.tail1234.ts.net";
const networkHost = "192.168.1.20:4380";

// The middleware inside a real HTTP server, a hook with its one-time secret, and
// `post` for requests from loopback with any Host and headers.
async function endpoint(t, { network = false, throttle } = {}) {
  const f = hookFixture(t);
  const { hook, secret } = f.hooks.create(f.id, { name: "Zabbix", sender: "zabbix01" });
  const config = {
    port: 0,
    remoteUrl: `https://${remoteHost}`,
    network: { enabled: network },
    networkHosts: new Set([networkHost]),
  };
  const app = express();
  app.use(hookEndpoint({ assistantRoutines: f.routines }, () => config, { throttle }));
  app.use((req, res) => res.status(418).json({ next: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const local = `127.0.0.1:${config.port}`;
  const post = (headers = {}, options = {}) => {
    const {
      path = `/hooks/${hook.id}`,
      method = "POST",
      data = '{"id":"e1","host":"db1"}',
      auth = `Bearer ${secret}`,
      type = "application/json",
      host = local,
      chunked = false,
    } = options;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const all = { host, "content-type": type, ...headers };
    if (auth) all.authorization = auth;
    if (method === "POST" && !chunked) all["content-length"] = payload.length;
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: config.port, path, method, headers: all },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text,
              body: json(text),
            });
          });
        },
      );
      req.on("error", reject);
      if (chunked)
        for (let at = 0; at < payload.length; at += 8192)
          req.write(payload.subarray(at, at + 8192));
      req.end(method === "POST" && !chunked ? payload : undefined);
    });
  };
  return { f, hook, secret, post, config, local };
}
function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

test("a loopback delivery with the right secret is accepted", async (t) => {
  const { f, post } = await endpoint(t);
  const r = await post();
  assert.equal(r.status, 202);
  assert.deepEqual(r.body, { eventId: "e1", status: "accepted" });
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 1);
  assert.equal(deliveries(f).at(-1).details.branch, "local");
});

test("other paths pass through and non-POST methods answer 405", async (t) => {
  const { post, hook } = await endpoint(t);
  assert.equal((await post({}, { path: "/api/health", method: "GET" })).status, 418);
  const r = await post({}, { method: "GET" });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, "POST");
  assert.equal(
    (await post({}, { path: `/hooks/${hook.id}`, method: "PUT" })).status,
    405,
  );
});

test("Funnel, browser and query-token requests are refused", async (t) => {
  const { f, post, hook, secret } = await endpoint(t);
  for (const headers of [
    { "tailscale-funnel-request": "?1" },
    { origin: "http://evil" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-origin" },
    { "x-forwarded-for": "100.64.0.9" },
  ]) {
    const r = await post(headers);
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.deepEqual(r.body, { error: "HOOK_FORBIDDEN" });
  }
  assert.equal((await post({}, { path: `/hooks/${hook.id}?token=x` })).status, 403);
  assert.equal(
    (await post({}, { path: `/hooks/${hook.id}?token=${secret}`, auth: null })).status,
    403,
  );
  // Funnel on the Tailscale host is refused as well.
  assert.equal(
    (await post({ "tailscale-funnel-request": "?1" }, { host: remoteHost })).status,
    403,
  );
  assert.equal((await post({}, { host: "evil.example" })).status, 403);
  assert.equal(f.calls.length, 0);
});

test("the Tailscale host needs no identity, the network host needs network mode", async (t) => {
  const tailnet = await endpoint(t);
  const r = await tailnet.post({ "x-forwarded-for": "100.64.0.9" }, { host: remoteHost });
  assert.equal(r.status, 202);
  assert.equal(deliveries(tailnet.f).at(-1).details.branch, "tailscale");
  // Network mode off: the LAN host is not a branch.
  assert.equal((await tailnet.post({}, { host: networkHost })).status, 403);

  const lan = await endpoint(t, { network: true });
  assert.equal((await lan.post({}, { host: networkHost })).status, 202);
  assert.equal(deliveries(lan.f).at(-1).details.branch, "network");
  // Tailscale markers never enter the network branch.
  assert.equal(
    (await lan.post({ "tailscale-user-login": "a@b" }, { host: networkHost })).status,
    403,
  );
});

test("unknown and disabled hooks answer the same 404", async (t) => {
  const { f, post, hook } = await endpoint(t);
  const unknown = await post({}, { path: `/hooks/${randomUUID()}` });
  const malformed = await post({}, { path: "/hooks/not-a-hook" });
  f.hooks.update(f.id, hook.id, { revision: hook.revision, enabled: false });
  const disabled = await post();
  const stored = f.store.getAssistant(f.id);
  f.store.db.prepare("UPDATE assistants SET body=? WHERE id=?").run(
    JSON.stringify({
      ...stored,
      capabilities: { ...stored.capabilities, reminders: false },
    }),
    f.id,
  );
  f.hooks.store.patch(hook.id, { enabled: true });
  const ineligible = await post();
  const missingService = await (async () => {
    const app = express();
    const bare = { port: 0 };
    app.use(hookEndpoint({}, () => bare));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();
    bare.port = port;
    const res = await fetch(`http://127.0.0.1:${port}/hooks/${hook.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: res.status, text: await res.text() };
  })();
  for (const r of [unknown, malformed, disabled, ineligible, missingService]) {
    assert.equal(r.status, 404);
    assert.equal(r.text, '{"error":"HOOK_NOT_FOUND"}');
  }
  assert.equal(f.calls.length, 0);
});

test("a wrong secret answers 401 and repeated failures are throttled per source", async (t) => {
  const { f, post, secret } = await endpoint(t);
  const missing = await post({}, { auth: null });
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.body, { error: "HOOK_UNAUTHORIZED" });
  for (let i = 0; i < 9; i += 1)
    assert.equal((await post({}, { auth: "Bearer aph_wrong" })).status, 401);
  const blocked = await post({}, { auth: "Bearer aph_wrong" });
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, { error: "HOOK_RATE_LIMITED" });
  const seconds = Number(blocked.headers["retry-after"]);
  assert.ok(seconds > 590 && seconds <= 600, String(seconds));
  // The right secret from the blocked source waits as well.
  assert.equal((await post({}, { auth: `Bearer ${secret}` })).status, 429);
  // Another source key is not affected.
  const other = await post(
    { "x-forwarded-for": "100.64.0.9" },
    { host: remoteHost, auth: "Bearer aph_wrong" },
  );
  assert.equal(other.status, 401);
  // A 404 with a well-formed id counts as a failed attempt too.
  for (let i = 0; i < 9; i += 1)
    assert.equal(
      (
        await post(
          { "x-forwarded-for": "100.64.0.9" },
          { host: remoteHost, path: `/hooks/${randomUUID()}` },
        )
      ).status,
      404,
    );
  assert.equal(
    (await post({ "x-forwarded-for": "100.64.0.9" }, { host: remoteHost })).status,
    429,
  );
  assert.equal(f.calls.length, 0);
});

test("a hook without a secret answers 401 and the Bearer scheme ignores case", async (t) => {
  const { f, post, secret } = await endpoint(t);
  assert.equal((await post({}, { auth: `bearer ${secret}` })).status, 202);
  const { hook } = f.hooks.create(
    f.id,
    { name: "Proposed", sender: "ci" },
    { actor: "assistant" },
  );
  assert.equal(f.hooks.store.get(hook.id).secretHash, null);
  for (const auth of [null, "Bearer aph_anything", `Bearer ${secret}`]) {
    const r = await post({}, { path: `/hooks/${hook.id}`, auth });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "HOOK_UNAUTHORIZED" });
  }
});

test("rotating X-Forwarded-For values share one tailnet window and a capped map", async (t) => {
  const throttle = new AuthThrottle({ maxKeys: 5 });
  const { f, post } = await endpoint(t, { throttle });
  for (let i = 0; i < 10; i += 1) {
    const r = await post(
      { "x-forwarded-for": `100.64.0.${i}` },
      { host: remoteHost, auth: "Bearer aph_wrong" },
    );
    assert.equal(r.status, 401);
    assert.ok(throttle.failures.size <= 5, String(throttle.failures.size));
  }
  const fresh = await post({ "x-forwarded-for": "100.64.1.1" }, { host: remoteHost });
  assert.equal(fresh.status, 429);
  assert.ok(Number(fresh.headers["retry-after"]) > 0);
  assert.ok(throttle.failures.has("tailscale"));
  // The local machine keeps its own window.
  assert.equal((await post()).status, 202);
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 1);
});

test("the auth throttle evicts the least recently failed key, never a fixed one", () => {
  let now = 0;
  const throttle = new AuthThrottle({ now: () => now, limit: 3, maxKeys: 3 });
  throttle.fail("local");
  throttle.fail(["tailscale:a", "tailscale"]);
  for (let i = 0; i < 50; i += 1) {
    now += 1;
    throttle.fail(`network:${i}`);
    assert.ok(throttle.failures.size <= 3);
  }
  assert.ok(throttle.failures.has("local"));
  assert.ok(throttle.failures.has("tailscale"));
  assert.ok(throttle.failures.has("network:49"));
  assert.ok(!throttle.failures.has("tailscale:a"));
  // Each key keeps at most `limit` failures.
  for (let i = 0; i < 20; i += 1) throttle.fail("local");
  assert.equal(throttle.failures.get("local").length, 3);
  assert.ok(throttle.blocked(["local"]) > 0);
});

test("the auth throttle frees a source when its window ends", () => {
  let now = 1000;
  const throttle = new AuthThrottle({ now: () => now, limit: 2, windowMs: 100 });
  assert.equal(throttle.blocked("a"), 0);
  throttle.fail("a");
  now = 1050;
  throttle.fail("a");
  assert.equal(throttle.blocked("a"), 50);
  assert.equal(throttle.blocked("b"), 0);
  now = 1099;
  assert.equal(throttle.blocked("a"), 1);
  now = 1100;
  assert.equal(throttle.blocked("a"), 0);
});

test("bodies over 64 KiB answer 413 and unsupported types 415", async (t) => {
  const { f, post } = await endpoint(t);
  const big = await post({}, { data: Buffer.alloc(65537, "a"), type: "text/plain" });
  assert.equal(big.status, 413);
  assert.deepEqual(big.body, { error: "HOOK_TOO_LARGE" });
  // Without Content-Length the streamed body is counted as it arrives.
  const streamed = await post(
    {},
    { data: Buffer.alloc(65537, "b"), type: "text/plain", chunked: true },
  );
  assert.equal(streamed.status, 413);
  assert.deepEqual(streamed.body, { error: "HOOK_TOO_LARGE" });
  const exact = await post(
    {},
    { data: Buffer.alloc(65536, "a"), type: "text/plain", chunked: true },
  );
  assert.equal(exact.status, 202);
  const xml = await post({}, { data: "<a/>", type: "application/xml" });
  assert.equal(xml.status, 415);
  assert.deepEqual(xml.body, { error: "HOOK_UNSUPPORTED_TYPE" });
  assert.equal((await post({}, { type: "" })).status, 415);
  for (const data of ["{nope", ""]) {
    const r = await post({}, { data });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "HOOK_INVALID_BODY" });
  }
  const plain = await post({}, { data: "disk full", type: "text/plain; charset=utf-8" });
  assert.equal(plain.status, 202);
  assert.match(plain.body.eventId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 2);
});

test("a not-ready runtime answers 503 with Retry-After", async (t) => {
  const { f, post } = await endpoint(t);
  f.setReady(false);
  const r = await post();
  assert.equal(r.status, 503);
  assert.equal(r.headers["retry-after"], "30");
  assert.deepEqual(r.body, { eventId: "e1", status: "unavailable" });
  assert.deepEqual(f.hooks.events.forAssistant(f.id), []);
});

test("parallel identical deliveries start one run", async (t) => {
  const { f, post } = await endpoint(t);
  const results = await Promise.all([
    post({ "x-event-id": "same" }, { data: '{"n":1}' }),
    post({ "x-event-id": "same" }, { data: '{"n":2}' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 202]);
  assert.deepEqual(results.map((r) => r.body.status).sort(), ["accepted", "duplicate"]);
  assert.ok(results.every((r) => r.body.eventId === "same"));
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 1);
});

test("every delivery outcome is audited without payload, headers or secret", async (t) => {
  const { f, post, hook, secret } = await endpoint(t);
  f.hooks.update(f.id, hook.id, { revision: hook.revision, hourlyLimit: 1 });
  const marker = "PAYLOAD-MARKER-7d1";
  const data = `{"id":"a1","note":"${marker}"}`;
  const header = { "x-custom": "HEADER-MARKER-9e2" };
  assert.equal((await post(header, { data })).status, 202);
  assert.equal((await post(header, { data })).status, 200);
  const throttled = await post(header, { data: `{"id":"a2","note":"${marker}"}` });
  assert.equal(throttled.body.status, "throttled");
  assert.equal((await post(header, { auth: "Bearer aph_wrong" })).status, 401);
  assert.equal(
    (await post(header, { data: Buffer.alloc(70000, "a"), type: "text/plain" })).status,
    413,
  );
  assert.equal((await post(header, { data: "{bad" })).status, 400);
  assert.equal(
    (await post(header, { data: "<a/>", type: "application/xml" })).status,
    415,
  );
  f.setReady(false);
  assert.equal((await post(header, { data: '{"id":"a3"}' })).status, 503);
  const audits = deliveries(f);
  assert.deepEqual(
    audits.map((a) => a.details.outcome),
    [
      "accepted",
      "duplicate",
      "throttled",
      "unauthorized",
      "too-large",
      "invalid",
      "invalid",
      "unavailable",
    ],
  );
  for (const a of audits) {
    assert.equal(a.details.hookId, hook.id);
    assert.equal(a.resourceId, f.id);
    assert.equal(a.details.branch, "local");
    assert.ok(Number.isSafeInteger(a.details.size));
  }
  assert.equal(audits[4].details.size, 70000);
  assert.deepEqual(
    audits.slice(3).map((a) => a.outcome),
    ["failure", "failure", "failure", "failure", "failure"],
  );
  const text = JSON.stringify(f.audits);
  for (const secretPart of [marker, "HEADER-MARKER", secret, "aph_wrong", "Bearer"])
    assert.ok(!text.includes(secretPart), secretPart);
});
