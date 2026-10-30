import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const publicFile = (name) => new URL(`../../public/${name}`, import.meta.url);

// The service worker in a VM with an in-memory cache, push manager and fetch.
function worker() {
  const stored = new Map(),
    handlers = new Map(),
    requests = [],
    subscribed = [];
  const renewed = {
    toJSON: () => ({ endpoint: "https://push.example.com/renewed", keys: {} }),
  };
  const scope = {
    navigator: { languages: ["en"] },
    location: { origin: "https://fixture.example" },
    addEventListener: (name, handler) => handlers.set(name, handler),
    registration: {
      pushManager: {
        subscribe: async (options) => {
          subscribed.push(options);
          return renewed;
        },
      },
    },
  };
  const context = vm.createContext({
    self: scope,
    URL,
    Response,
    atob,
    Uint8Array,
    JSON,
    fetch: async (url, init = {}) => {
      requests.push({ url, ...init });
      return new Response(JSON.stringify({ publicKey: "AQIDBA" }));
    },
    caches: {
      open: async (cache) => ({
        match: async (key) => stored.get(`${cache}:${key}`)?.clone(),
        put: async (key, value) => stored.set(`${cache}:${key}`, value),
        delete: async (key) => stored.delete(`${cache}:${key}`),
      }),
    },
    importScripts: (...names) => {
      for (const name of names)
        vm.runInContext(fs.readFileSync(publicFile(name.slice(1)), "utf8"), context);
    },
  });
  vm.runInContext(fs.readFileSync(publicFile("sw.js"), "utf8"), context);
  const dispatch = async (name, fields) => {
    let pending;
    handlers.get(name)({ ...fields, waitUntil: (promise) => (pending = promise) });
    await pending;
  };
  return { dispatch, requests, subscribed, stored, renewed };
}

test("a replaced subscription is renewed under the page's device and person", async () => {
  const w = worker();
  await w.dispatch("message", {
    data: { type: "agentpier-device", deviceId: "device-one", base: "/me/notifications" },
  });
  await w.dispatch("pushsubscriptionchange", { newSubscription: w.renewed });
  assert.equal(w.requests.length, 1);
  assert.equal(w.requests[0].url, "/api/me/notifications/renew");
  assert.equal(w.requests[0].method, "POST");
  assert.deepEqual(JSON.parse(w.requests[0].body), {
    deviceId: "device-one",
    subscription: { endpoint: "https://push.example.com/renewed", keys: {} },
  });
});

test("a dropped subscription subscribes again with the server's key", async () => {
  const w = worker();
  await w.dispatch("message", {
    data: { type: "agentpier-device", deviceId: "device-one", base: "/notifications" },
  });
  await w.dispatch("pushsubscriptionchange", { oldSubscription: null });
  assert.deepEqual(
    w.requests.map((request) => request.url),
    ["/api/notifications", "/api/notifications/renew"],
  );
  assert.equal(w.subscribed[0].userVisibleOnly, true);
  assert.deepEqual([...w.subscribed[0].applicationServerKey], [1, 2, 3, 4]);
});

test("after sign-out, or with an unknown API, nothing is renewed", async () => {
  const w = worker();
  await w.dispatch("message", {
    data: { type: "agentpier-device", deviceId: "device-one", base: "/notifications" },
  });
  await w.dispatch("message", { data: { type: "agentpier-device" } });
  await w.dispatch("pushsubscriptionchange", { newSubscription: w.renewed });
  await w.dispatch("message", {
    data: { type: "agentpier-device", deviceId: "device-one", base: "/api/admin" },
  });
  await w.dispatch("pushsubscriptionchange", { newSubscription: w.renewed });
  assert.equal(w.requests.length, 0);
  assert.equal(w.stored.size, 0);
});
