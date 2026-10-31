import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { listenForNotificationOpen } from "../../web/features/notifications/notification-open.js";

// Tapping a notification (public/sw.js openLink, AGENTPIER-297): an open AgentPier
// window comes to the front and shows the page in place through its own router;
// navigating it and a new window are the fallbacks.
const origin = "https://pier.example";
const publicFile = (name) => new URL(`../../public/${name}`, import.meta.url);

// A window: `answer` is what its page replies to an open message (undefined: no
// listener, as in an app version from before), `navigate` false for a platform
// without WindowClient.navigate, "reject" for a window the worker does not control.
function windowClient(
  log,
  { url = `${origin}/`, answer, navigate = true, focus = true, focused = false } = {},
) {
  const client = {
    url,
    focused,
    visibilityState: focused ? "visible" : "hidden",
    focus: async () => {
      log.push(["focus", client.url]);
      if (!focus) throw new Error("not allowed");
      return client;
    },
    postMessage: (message, [port]) => {
      log.push(["message", message.type, message.link]);
      if (answer !== undefined) port.postMessage({ opened: answer });
    },
  };
  if (navigate)
    client.navigate = async (target) => {
      log.push(["navigate", target]);
      if (navigate === "reject") throw new TypeError("not controlled");
      client.url = target;
      return client;
    };
  return client;
}

function worker(windows = [], { decided = true } = {}) {
  const handlers = new Map(),
    log = [];
  const clients = windows.map((options) => windowClient(log, options));
  const scope = {
    navigator: { languages: ["en"] },
    location: { origin },
    addEventListener: (name, handler) => handlers.set(name, handler),
    registration: { showNotification: async () => {} },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url) => log.push(["openWindow", url]),
    },
  };
  const context = vm.createContext({
    self: scope,
    URL,
    Response,
    JSON,
    MessageChannel,
    // An unanswered open message gives up at once in tests.
    setTimeout: (callback) => setTimeout(callback, 5),
    clearTimeout,
    fetch: async (url) => {
      log.push(["fetch", url]);
      return new Response("{}", { status: decided ? 200 : 409 });
    },
    caches: { open: async () => ({ match: async () => undefined }) },
    importScripts: (...names) => {
      for (const name of names)
        vm.runInContext(fs.readFileSync(publicFile(name.slice(1)), "utf8"), context);
    },
  });
  vm.runInContext(fs.readFileSync(publicFile("sw.js"), "utf8"), context);
  const click = async (data, action) => {
    let pending;
    handlers.get("notificationclick")({
      action,
      notification: { close() {}, data },
      waitUntil: (promise) => (pending = promise),
    });
    await pending;
    return log;
  };
  return { click, log };
}

const chat = { link: "/agents/a1/chats/c1" };
const chatUrl = `${origin}/agents/a1/chats/c1`;

test("without an open window a tap opens the page in a new one", async () => {
  assert.deepEqual(await worker().click(chat), [["openWindow", chatUrl]]);
});

test("a window already at the page only comes to the front", async () => {
  assert.deepEqual(await worker([{ url: chatUrl }]).click(chat), [["focus", chatUrl]]);
});

test("an open window comes to the front first, then its router shows the page", async () => {
  const log = await worker([{ url: `${origin}/inbox`, answer: true }]).click(chat);
  assert.deepEqual(log, [
    ["focus", `${origin}/inbox`],
    ["message", "agentpier-open", "/agents/a1/chats/c1"],
  ]);
});

test("a page that does not answer is navigated, never opened twice", async () => {
  const log = await worker([{ url: `${origin}/` }]).click(chat);
  assert.deepEqual(log, [
    ["focus", `${origin}/`],
    ["message", "agentpier-open", "/agents/a1/chats/c1"],
    ["navigate", chatUrl],
  ]);
});

test("without navigate (iPhone and iPad) or control, a new window is the last resort", async () => {
  for (const navigate of [false, "reject"]) {
    const log = await worker([{ answer: false, navigate }]).click(chat);
    assert.deepEqual(log.at(-1), ["openWindow", chatUrl], String(navigate));
    assert.equal(log.filter(([step]) => step === "openWindow").length, 1);
  }
});

test("a refused focus still lets the page follow the message", async () => {
  const log = await worker([{ answer: true, focus: false }]).click(chat);
  assert.deepEqual(log, [
    ["focus", `${origin}/`],
    ["message", "agentpier-open", "/agents/a1/chats/c1"],
  ]);
});

test("the focused window takes the tap; windows of other origins never do", async () => {
  const log = await worker([
    { url: "https://other.example/agents/a1/chats/c1", answer: true },
    { url: `${origin}/settings`, answer: true },
    { url: `${origin}/inbox`, answer: true, focused: true },
  ]).click(chat);
  assert.deepEqual(log[0], ["focus", `${origin}/inbox`]);
  assert.equal(log.length, 2);
});

test("an invalid link opens the notification settings instead", async () => {
  const log = await worker().click({ link: "https://evil.example/" });
  assert.deepEqual(log, [["openWindow", `${origin}/settings/notifications`]]);
});

const approval = {
  link: "/sessions/s1/chat",
  item: "/inbox/approval/r1",
  decision: { type: "approval", id: "r1", revision: 3, allow: true },
};

test("Allow once and Deny decide without opening anything", async () => {
  for (const action of ["allow", "deny"]) {
    const log = await worker([{ answer: true }]).click(approval, action);
    assert.deepEqual(log, [["fetch", "/api/notifications/decide"]], action);
  }
});

test("a failed decision opens the inbox item, in the open window", async () => {
  const log = await worker([{ answer: true }], { decided: false }).click(
    approval,
    "deny",
  );
  assert.deepEqual(log, [
    ["fetch", "/api/notifications/decide"],
    ["focus", `${origin}/`],
    ["message", "agentpier-open", "/inbox/approval/r1"],
  ]);
});

test("tapping an approval's body opens its session, not the inbox", async () => {
  const log = await worker([{ answer: true }]).click(approval);
  assert.deepEqual(log.at(-1), ["message", "agentpier-open", "/sessions/s1/chat"]);
});

// The page side: navigator.serviceWorker's messages.
function container() {
  const listeners = new Set();
  return {
    started: 0,
    addEventListener: (type, listener) => type === "message" && listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
    startMessages() {
      this.started += 1;
    },
    post(data, eventOrigin = origin) {
      const replies = [];
      for (const listener of listeners)
        listener({
          data,
          origin: eventOrigin,
          ports: [{ postMessage: (m) => replies.push(m) }],
        });
      return replies;
    },
    get size() {
      return listeners.size;
    },
  };
}

test("an open app shows a tapped notice's page with its router and says so", () => {
  const worker = container(),
    opened = [];
  const stop = listenForNotificationOpen(
    (url) => {
      opened.push(url.pathname + url.search);
      return url.pathname !== "/nowhere";
    },
    { container: worker, origin },
  );
  assert.equal(worker.started, 1);
  assert.deepEqual(worker.post({ type: "agentpier-open", link: "/agents/a1/chats/c1" }), [
    { opened: true },
  ]);
  assert.deepEqual(worker.post({ type: "agentpier-open", link: "/nowhere" }), [
    { opened: false },
  ]);
  // Another origin's address, a foreign sender and other messages open nothing.
  assert.deepEqual(worker.post({ type: "agentpier-open", link: "//evil.example/x" }), [
    { opened: false },
  ]);
  assert.deepEqual(
    worker.post({ type: "agentpier-open", link: "/inbox" }, "https://evil.example"),
    [],
  );
  assert.deepEqual(worker.post({ type: "agentpier-language", language: "en" }), []);
  assert.deepEqual(opened, ["/agents/a1/chats/c1", "/nowhere"]);
  stop();
  assert.equal(worker.size, 0);
});

test("without service workers the app listens to nothing", () => {
  const stop = listenForNotificationOpen(() => true, { container: undefined, origin });
  assert.doesNotThrow(stop);
});
