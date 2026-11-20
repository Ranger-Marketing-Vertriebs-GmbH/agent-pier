import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const publicFile = (name) => new URL(`../../public/${name}`, import.meta.url);
const origin = "https://fixture.example";

// Loads public/sw.js with in-memory caches and a switchable network.
function worker() {
  const caches = new Map();
  const handlers = new Map();
  const network = { online: true, responses: new Map(), requests: [] };
  const open = async (name) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const entries = caches.get(name);
    const key = (request) => new URL(request.url ?? request, origin).pathname;
    return {
      match: async (request) => entries.get(key(request))?.clone(),
      put: async (request, response) => entries.set(key(request), response),
      addAll: async (paths) => {
        for (const path of paths) entries.set(path, new Response(`public ${path}`));
      },
    };
  };
  const context = vm.createContext({
    self: {
      navigator: { languages: ["en"] },
      location: { origin },
      addEventListener: (name, handler) => handlers.set(name, handler),
      registration: {},
    },
    URL,
    Response,
    caches: {
      open,
      keys: async () => [...caches.keys()],
      delete: async (name) => caches.delete(name),
    },
    fetch: async (request) => {
      const url = new URL(request.url);
      network.requests.push(url.pathname);
      if (!network.online) throw new TypeError("Failed to fetch");
      const make = network.responses.get(url.pathname);
      return make ? make() : new Response("missing", { status: 404 });
    },
    importScripts: (...names) => {
      for (const name of names)
        vm.runInContext(fs.readFileSync(publicFile(name.slice(1)), "utf8"), context);
    },
  });
  vm.runInContext(fs.readFileSync(publicFile("sw.js"), "utf8"), context);
  const pending = [];
  const waitUntil = (promise) => pending.push(promise);
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  async function request(path, mode = "same-origin") {
    let answer;
    handlers.get("fetch")({
      request: { method: "GET", url: origin + path, mode },
      respondWith: (value) => (answer = value),
      waitUntil,
    });
    const response = answer ? await answer : null;
    await settle();
    return response;
  }
  return {
    caches,
    network,
    navigate: (path) => request(path, "navigate"),
    load: (path) => request(path),
    install: async () => {
      handlers.get("install")({ waitUntil });
      await settle();
    },
  };
}
const appDocument =
  (build, body = `shell ${build}`) =>
  () =>
    new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "X-AgentPier-Build": build },
    });

test("a navigation without an answer opens the last app shell, not the offline page", async () => {
  const sw = worker();
  await sw.install();
  sw.network.responses.set("/", appDocument("build-a"));
  sw.network.responses.set("/agents", appDocument("build-a"));
  assert.equal(await (await sw.navigate("/")).text(), "shell build-a");
  sw.network.online = false;
  assert.equal(await (await sw.navigate("/agents/home")).text(), "shell build-a");
  // A file is not a page of the app: the offline page explains.
  assert.equal(await (await sw.navigate("/report.pdf")).text(), "public /offline.html");
});

test("without a kept shell the offline page opens", async () => {
  const sw = worker();
  await sw.install();
  sw.network.online = false;
  assert.equal(await (await sw.navigate("/")).text(), "public /offline.html");
});

test("only app documents become the shell, and the network always comes first", async () => {
  const sw = worker();
  await sw.install();
  sw.network.responses.set("/", appDocument("build-a"));
  await sw.navigate("/");
  // A 404 page and a document without a build never replace the shell.
  sw.network.responses.set(
    "/unknown",
    () =>
      new Response("not found", {
        status: 404,
        headers: { "Content-Type": "text/html", "X-AgentPier-Build": "build-a" },
      }),
  );
  await sw.navigate("/unknown");
  sw.network.responses.set(
    "/plain",
    () => new Response("plain", { headers: { "Content-Type": "text/html" } }),
  );
  await sw.navigate("/plain");
  // A new build replaces the shell at once while AgentPier answers.
  sw.network.responses.set("/", appDocument("build-b"));
  assert.equal(await (await sw.navigate("/")).text(), "shell build-b");
  sw.network.online = false;
  assert.equal(await (await sw.navigate("/")).text(), "shell build-b");
});

test("hashed assets stay for offline starts and go with their build", async () => {
  const sw = worker();
  await sw.install();
  const asset = "/assets/index-AbCd1234.js";
  sw.network.responses.set("/", appDocument("build-a"));
  sw.network.responses.set(asset, () => new Response("code a"));
  sw.network.responses.set("/favicon.svg", () => new Response("icon"));
  await sw.navigate("/");
  assert.equal(await (await sw.load(asset)).text(), "code a");
  // Unhashed files are left to the browser.
  assert.equal(await sw.load("/favicon.svg"), null);
  sw.network.online = false;
  assert.equal(await (await sw.load(asset)).text(), "code a");
  sw.network.online = true;
  sw.network.responses.set("/", appDocument("build-b"));
  await sw.navigate("/");
  assert.equal(sw.caches.get("agentpier-assets-v1"), undefined);
});
