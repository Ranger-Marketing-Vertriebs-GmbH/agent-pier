import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../../public/offline.js", import.meta.url),
  "utf8",
);

// Runs offline.js against fake page globals. `answers` decides each probe: true for an
// HTTP answer from AgentPier, false for a network failure.
function openOfflinePage({ language = "en", online = true, answers = [] } = {}) {
  const nodes = {
    h1: { textContent: "" },
    p: { textContent: "" },
    "#offline-status": { textContent: "" },
    a: {
      textContent: "",
      addEventListener: (name, handler) => (nodes.a.click = handler),
    },
  };
  const timers = [];
  const listeners = new Map();
  const probes = [];
  const page = {
    reloads: 0,
    nodes,
    timers,
    probes,
    listeners,
    navigator: { onLine: online, languages: ["de-DE"] },
  };
  const context = {
    localStorage: { getItem: () => language },
    navigator: page.navigator,
    document: {
      documentElement: {},
      visibilityState: "visible",
      querySelector: (name) => nodes[name],
      addEventListener: (name, handler) => listeners.set(`document:${name}`, handler),
    },
    addEventListener: (name, handler) => listeners.set(name, handler),
    setTimeout: (run, delay) => {
      timers.push({ run, delay });
      return timers.length;
    },
    clearTimeout: () => {},
    location: { reload: () => (page.reloads += 1) },
    fetch: async (url, init) => {
      probes.push({ url, init });
      if (answers.shift()) return new Response("{}", { status: 401 });
      throw new TypeError("Failed to fetch");
    },
  };
  vm.runInNewContext(source, context);
  return page;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an online device blames AgentPier, not the network", () => {
  const page = openOfflinePage({ language: "en", online: true });
  assert.equal(page.nodes.h1.textContent, "AgentPier is not reachable");
  assert.match(page.nodes.p.textContent, /This device is online/);
  assert.doesNotMatch(page.nodes.p.textContent, /Connect this device/);
  const german = openOfflinePage({ language: "de", online: true });
  assert.equal(german.nodes.h1.textContent, "AgentPier ist nicht erreichbar");
});

test("an offline device asks for a network connection", () => {
  const page = openOfflinePage({ language: "en", online: false });
  assert.equal(page.nodes.h1.textContent, "This device is offline");
  assert.match(page.nodes.p.textContent, /Connect this device/);
  const german = openOfflinePage({ language: "de", online: false });
  assert.equal(german.nodes.h1.textContent, "Dieses Gerät ist offline");
});

test("the page retries with growing delays and reloads once AgentPier answers", async () => {
  const page = openOfflinePage({ answers: [false, false, true] });
  const delays = [];
  for (let round = 0; round < 3; round += 1) {
    const timer = page.timers.at(-1);
    delays.push(timer.delay);
    timer.run();
    await settle();
  }
  assert.ok(delays[0] >= 1000, "the first try waits a moment");
  assert.ok(delays[1] > delays[0] && delays[2] > delays[1], "the delay grows");
  assert.equal(page.probes.length, 3);
  assert.equal(page.probes[0].url, "/api/health");
  assert.equal(page.probes[0].init.cache, "no-store");
  assert.equal(page.reloads, 1);
  assert.match(page.nodes["#offline-status"].textContent, /AgentPier answers again/i);
});

test("the delay stops growing, and coming online or the button tries at once", async () => {
  const page = openOfflinePage({ online: false, answers: new Array(20).fill(false) });
  for (let round = 0; round < 12; round += 1) {
    page.timers.at(-1).run();
    await settle();
  }
  assert.ok(page.timers.at(-1).delay <= 60_000);
  page.navigator.onLine = true;
  page.listeners.get("online")();
  await settle();
  assert.equal(page.nodes.h1.textContent, "AgentPier is not reachable");
  assert.equal(page.probes.length, 13);
  let prevented = false;
  page.nodes.a.click({ preventDefault: () => (prevented = true) });
  await settle();
  assert.ok(prevented);
  assert.equal(page.probes.length, 14);
  assert.equal(page.reloads, 0);
});
