import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { freePortRange } from "../helpers/preview-ports.js";
import { signedInUser } from "../helpers/users.js";
import { portAvailable } from "../../server/features/pipelines/run-ports.js";

const networkHost = "agentpier.home.arpa";

async function app(t, { stored = {}, ...extra } = {}) {
  const f = await applicationFixture(t, {
    prepareDataDir: async (dataDir) => {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dataDir, "config.json"), JSON.stringify(stored));
    },
    ...extra,
  });
  f.application.previews.sessionAlive = () => true;
  return f;
}
const put = (f, body, options) =>
  f.request("/api/previews/settings", { method: "PUT", body, ...options });
const saved = async (f) =>
  JSON.parse(await fs.readFile(path.join(f.application.config.dataDir, "config.json")));
const audited = (f) => f.application.audit.list().events;

/** A request that arrives on the plain network branch (Host is the network host). */
function onNetwork(f, body) {
  const port = new URL(f.url).port;
  return new Promise((resolve, reject) => {
    const request = http.request(
      f.url + "/api/previews/settings",
      {
        method: "PUT",
        headers: {
          host: `${networkHost}:${port}`,
          origin: `http://${networkHost}:${port}`,
          cookie: f.cookie,
          "content-type": "application/json",
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode, text }));
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

test("the owner switches previews on and sets the range; config.json keeps its other keys", async (t) => {
  const range = await freePortRange(10);
  const f = await app(t, { stored: { ownerLogin: "keep@example.com" } });
  const response = await put(f, {
    enabled: true,
    portRangeStart: range.start,
    portRangeEnd: range.end,
  });
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.deepEqual(view.settings, {
    enabled: true,
    portRangeStart: range.start,
    portRangeEnd: range.end,
  });
  assert.equal(view.slots.length, 10);
  assert.ok(view.slots.every((slot) => slot.state === "free"));
  const config = await saved(f);
  assert.equal(config.ownerLogin, "keep@example.com");
  assert.deepEqual(config.previews, view.settings);
  assert.equal(await portAvailable(range.start), false);
  const events = audited(f);
  assert.ok(
    events.some(
      (event) =>
        event.action === "setting.updated" &&
        event.resourceId === "previews" &&
        event.details?.enabled === true &&
        event.details?.count === 10,
    ),
  );
});

test("a range over 50 ports or containing AgentPier's port answers 400", async (t) => {
  const f = await app(t);
  const own = Number(new URL(f.url).port);
  for (const body of [
    { enabled: true, portRangeStart: 40000, portRangeEnd: 40050 },
    { enabled: true, portRangeStart: Math.max(1024, own - 2), portRangeEnd: own + 2 },
    { enabled: true, portRangeStart: 80, portRangeEnd: 90 },
    { enabled: "yes", portRangeStart: 40000, portRangeEnd: 40001 },
    { enabled: true, portRangeStart: 40000, portRangeEnd: 40001, extra: 1 },
  ]) {
    const response = await put(f, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, "PREVIEW_RANGE_INVALID");
  }
  assert.equal((await saved(f)).previews, undefined);
});

test("a network-branch request may only switch previews off", async (t) => {
  const range = await freePortRange(3);
  const on = { enabled: true, portRangeStart: range.start, portRangeEnd: range.end };
  const f = await app(t, {
    network: { enabled: true, bind: "127.0.0.1", hosts: [networkHost] },
    stored: { previews: on },
  });
  await f.application.previews.start();
  const refused = await onNetwork(f, { ...on, portRangeEnd: range.end - 1 });
  assert.equal(refused.status, 403);
  const stillOn = await onNetwork(f, on);
  assert.equal(stillOn.status, 403);
  assert.equal((await saved(f)).previews.enabled, true);
  const off = await onNetwork(f, { ...on, enabled: false });
  assert.equal(off.status, 200);
  assert.equal((await saved(f)).previews.enabled, false);
  assert.equal(await portAvailable(range.start), true);
});

test("a restricted user reaches none of the preview routes", async (t) => {
  const f = await app(t);
  const { cookie } = await signedInUser(f);
  const unknown = await (await f.request("/api/does-not-exist")).json();
  for (const [method, endpoint, body] of [
    ["GET", "/api/previews"],
    ["DELETE", "/api/previews/anything"],
    ["PUT", "/api/previews/settings", { enabled: false }],
  ]) {
    const response = await f.request(endpoint, {
      method,
      body,
      headers: { cookie },
    });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
    assert.deepEqual(await response.json(), unknown);
  }
  assert.equal((await saved(f)).previews, undefined);
});

test("DELETE stops a preview and audits preview.stopped with reason owner", async (t) => {
  const range = await freePortRange(2);
  const f = await app(t, {
    stored: {
      previews: { enabled: true, portRangeStart: range.start, portRangeEnd: range.end },
    },
  });
  const { default: net } = await import("node:net");
  const upstream = net.createServer().listen(0, "127.0.0.1");
  t.after(() => upstream.close());
  await new Promise((resolve) => upstream.once("listening", resolve));
  const opened = await f.application.previews.open({
    owner: { kind: "session", sessionId: "s1", project: f.project },
    port: upstream.address().port,
  });
  const response = await f.request(`/api/previews/${opened.id}`, { method: "DELETE" });
  assert.equal(response.status, 204);
  assert.deepEqual((await (await f.request("/api/previews")).json()).previews, []);
  const gone = await f.request(`/api/previews/${opened.id}`, { method: "DELETE" });
  assert.equal(gone.status, 404);
  const stopped = audited(f).find((event) => event.action === "preview.stopped");
  assert.equal(stopped?.details?.reason, "owner");
  assert.equal(stopped?.source, "user");
});
