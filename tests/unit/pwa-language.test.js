import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const publicFile = (name) => new URL(`../../public/${name}`, import.meta.url);
test("worker persists only a supported language and localizes generic notifications", async () => {
  const stored = new Map();
  const handlers = new Map();
  let notification;
  const scope = {
    navigator: { languages: ["de-DE"] },
    location: { origin: "https://fixture.example" },
    addEventListener: (name, handler) => handlers.set(name, handler),
    registration: {
      showNotification: async (title, options) => {
        notification = { title, options };
      },
    },
  };
  const context = vm.createContext({
    self: scope,
    URL,
    Response,
    caches: {
      open: async (cache) => ({
        match: async (key) => stored.get(`${cache}:${key}`)?.clone(),
        put: async (key, value) => stored.set(`${cache}:${key}`, value),
      }),
    },
    importScripts: (...names) => {
      for (const name of names)
        vm.runInContext(fs.readFileSync(publicFile(name.slice(1)), "utf8"), context);
    },
  });
  vm.runInContext(fs.readFileSync(publicFile("sw.js"), "utf8"), context);
  assert.equal(typeof handlers.get("message"), "function");
  async function dispatch(name, fields) {
    let pending;
    handlers.get(name)({
      ...fields,
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    await pending;
  }
  await dispatch("message", { data: { type: "agentpier-language", language: "en" } });
  assert.equal(stored.size, 1);
  await dispatch("message", {
    data: { type: "agentpier-language", language: "fr", secret: "never cache" },
  });
  assert.equal(stored.size, 1);
  await dispatch("push", {
    data: { json: () => ({ kind: "permission", title: "PRIVATE", body: "PRIVATE" }) },
  });
  assert.equal(notification.title, "AgentPier: Approval required");
  assert.doesNotMatch(JSON.stringify(notification), /PRIVATE/);
});

test("offline help uses the saved language ahead of browser settings", () => {
  const nodes = { h1: {}, p: {}, a: {} };
  const document = { documentElement: {}, querySelector: (name) => nodes[name] };
  vm.runInNewContext(fs.readFileSync(publicFile("offline.js"), "utf8"), {
    localStorage: { getItem: () => "en" },
    navigator: { languages: ["de-DE"] },
    document,
  });
  assert.equal(document.documentElement.lang, "en");
  assert.equal(nodes.h1.textContent, "AgentPier is offline");
  assert.equal(nodes.a.textContent, "Reconnect");
});
