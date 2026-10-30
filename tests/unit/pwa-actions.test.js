import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const publicFile = (name) => new URL(`../../public/${name}`, import.meta.url);

// The service worker in a VM: shown notifications, opened windows and fetches.
function worker({ status = 200 } = {}) {
  const handlers = new Map(),
    shown = [],
    opened = [],
    requests = [];
  const scope = {
    navigator: { languages: ["en"] },
    location: { origin: "https://fixture.example" },
    addEventListener: (name, handler) => handlers.set(name, handler),
    registration: {
      showNotification: async (title, options) => shown.push({ title, options }),
    },
    clients: {
      matchAll: async () => [],
      openWindow: async (url) => opened.push(url),
    },
  };
  const context = vm.createContext({
    self: scope,
    URL,
    Response,
    JSON,
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      return new Response("{}", { status });
    },
    caches: { open: async () => ({ match: async () => undefined }) },
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
  return { dispatch, shown, opened, requests };
}

const approval = {
  v: 2,
  kind: "permission",
  eventId: "r1",
  link: "/inbox/approval/r1",
  tag: "session:s1",
  label: "api-refactor",
  toolName: "Bash",
  decide: "both",
  revision: 3,
};
const plain = (value) => JSON.parse(JSON.stringify(value));

test("an approval names its tool and offers Allow once and Deny", async () => {
  const w = worker();
  await w.dispatch("push", { data: { json: () => approval } });
  const [{ title, options }] = plain(w.shown);
  assert.equal(title, "api-refactor · Approval required");
  assert.equal(options.body, "A session wants to use Bash.");
  assert.deepEqual(options.actions, [
    { action: "allow", title: "Allow once" },
    { action: "deny", title: "Deny" },
  ]);
  assert.deepEqual(options.data.decision, {
    type: "approval",
    id: "r1",
    revision: 3,
    allow: true,
  });
});

test("a deny-only approval offers Deny; other notices offer nothing", async () => {
  const w = worker();
  await w.dispatch("push", { data: { json: () => ({ ...approval, decide: "deny" }) } });
  await w.dispatch("push", {
    data: {
      json: () => ({
        ...approval,
        kind: "session-ended",
        link: "/sessions/s1/chat",
        decide: "both",
      }),
    },
  });
  const [deny, ended] = plain(w.shown);
  assert.deepEqual(deny.options.actions, [{ action: "deny", title: "Deny" }]);
  assert.equal(ended.options.actions, undefined);
  assert.equal(ended.options.data.decision, undefined);
});

test("Allow decides the named revision with the page's session; a tap opens the item", async () => {
  const w = worker();
  const data = {
    link: "/inbox/approval/r1",
    decision: { ...approval, type: "approval", id: "r1", revision: 3, allow: true },
  };
  await w.dispatch("notificationclick", {
    action: "allow",
    notification: { close() {}, data },
  });
  assert.equal(w.requests.length, 1);
  assert.equal(w.requests[0].url, "/api/notifications/decide");
  assert.deepEqual(JSON.parse(w.requests[0].body), {
    type: "approval",
    id: "r1",
    revision: 3,
    decision: "allow",
  });
  assert.equal(w.opened.length, 0);
  await w.dispatch("notificationclick", {
    action: "",
    notification: { close() {}, data },
  });
  assert.deepEqual(w.opened, ["https://fixture.example/inbox/approval/r1"]);
  assert.equal(w.requests.length, 1);
});

test("a refused decision opens the inbox item; Allow on a deny-only push does nothing", async () => {
  const w = worker({ status: 409 });
  const data = {
    link: "/inbox/action/a1",
    decision: { type: "action", id: "a1", revision: 1, allow: false },
  };
  await w.dispatch("notificationclick", {
    action: "deny",
    notification: { close() {}, data },
  });
  assert.deepEqual(w.opened, ["https://fixture.example/inbox/action/a1"]);
  await w.dispatch("notificationclick", {
    action: "allow",
    notification: { close() {}, data },
  });
  // Not a decision: it opens the item like a tap, and sends nothing.
  assert.equal(w.requests.length, 1);
});
