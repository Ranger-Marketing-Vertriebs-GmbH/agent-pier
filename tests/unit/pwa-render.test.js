import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { pushKinds } from "../../server/features/notifications/push-validation.js";

const publicFile = (name) => new URL(`../../public/${name}`, import.meta.url);
const scope = {};
const context = vm.createContext({ self: scope });
for (const name of ["pwa-de.js", "pwa-en.js", "pwa-render.js"])
  vm.runInContext(fs.readFileSync(publicFile(name), "utf8"), context);
const worker = scope.agentPierNotificationRender;
// Objects from the worker's realm, compared as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const render = (...args) => plain(worker.render(...args));
const options = (...args) => plain(worker.options(...args));
const { target, badgeCount } = worker;
const de = scope.agentPierNotificationCopy,
  en = scope.agentPierNotificationCopyEn;

test("both catalogs word every kind the server sends, with the same keys", () => {
  for (const catalog of [de, en]) {
    assert.deepEqual(Object.keys(catalog.kinds).sort(), [...pushKinds].sort());
    for (const copy of Object.values(catalog.kinds))
      assert.deepEqual(Object.keys(copy).sort(), ["body", "name", "title"]);
  }
  assert.deepEqual(Object.keys(de.subjects), Object.keys(en.subjects));
  assert.deepEqual(Object.keys(de.tools), Object.keys(en.tools));
});

test("the worker words each detail level in the owner's language", () => {
  const base = { v: 2, kind: "question", eventId: "r1", link: "/inbox/question/r1" };
  assert.deepEqual(render(base, en), {
    title: "AgentPier: Question",
    body: "A session is waiting for your answer.",
  });
  const label = { ...base, label: "api-refactor", tool: "claude", project: "shop" };
  assert.deepEqual(render(label, en), {
    title: "api-refactor · Question",
    body: "A session is waiting for your answer.\nClaude Code · shop",
  });
  assert.deepEqual(render({ ...label, preview: "Which database?" }, de), {
    title: "api-refactor · Rückfrage",
    body: "„Which database?“\nClaude Code · shop",
  });
  // An agent approval names what waits, never the command.
  assert.deepEqual(
    render({ v: 2, kind: "agent-approval", subject: "ssh", label: "Mira" }, en),
    { title: "Mira · SSH command", body: "An agent is waiting for your decision." },
  );
  assert.deepEqual(render({ v: 2, kind: "pipeline-failed", stage: "Tests" }, de), {
    title: "AgentPier: Pipeline fehlgeschlagen",
    body: "Öffne AgentPier, um zu sehen, was fehlschlug.\nTests",
  });
  // Unknown tools and non-text fields never show.
  assert.deepEqual(render({ ...base, tool: "evil", label: 42 }, en), {
    title: "AgentPier: Question",
    body: "A session is waiting for your answer.",
  });
});

test("grouped notices replace each other; links stay inside AgentPier", () => {
  const grouped = options({
    eventId: "r2",
    tag: "session:s1",
    renotify: true,
    link: "/inbox/question/r2",
  });
  assert.equal(grouped.tag, "session:s1");
  assert.equal(grouped.renotify, true);
  assert.deepEqual(grouped.data, { link: "/inbox/question/r2", group: "session:s1" });
  const single = options({ eventId: "r3", link: "/sessions/s1/chat" });
  assert.equal(single.tag, "r3");
  assert.equal(single.renotify, undefined);
  assert.deepEqual(single.data, { link: "/sessions/s1/chat" });
  assert.equal(options({ eventId: "../x", tag: "bad tag" }).tag, undefined);
  for (const link of ["//evil.example", "/api/state", "/inbox/other/x", "javascript:x"])
    assert.equal(target({ link }), "/settings/notifications", link);
  assert.equal(target({ link: "/agents/a1/chats/c1" }), "/agents/a1/chats/c1");
  assert.equal(badgeCount({ count: 3 }), 3);
  assert.equal(badgeCount({ count: -1 }), null);
  assert.equal(badgeCount({}), null);
});

test("the worker sets the app badge and closes an older notice of the same group", async () => {
  const handlers = new Map();
  const shown = [];
  const closed = [];
  let badge;
  const worker = {
    navigator: {
      languages: ["en-US"],
      setAppBadge: async (count) => (badge = count),
      clearAppBadge: async () => (badge = 0),
    },
    location: { origin: "https://fixture.example" },
    addEventListener: (name, handler) => handlers.set(name, handler),
    registration: {
      getNotifications: async () => [
        { data: { group: "session:s1" }, close: () => closed.push("s1") },
        { data: { group: "session:s2" }, close: () => closed.push("s2") },
      ],
      showNotification: async (title, value) => shown.push({ title, ...value }),
    },
  };
  const sandbox = vm.createContext({
    self: worker,
    URL,
    Response,
    caches: { open: async () => ({ match: async () => undefined, put: async () => {} }) },
    importScripts: (...names) => {
      for (const name of names)
        vm.runInContext(fs.readFileSync(publicFile(name.slice(1)), "utf8"), sandbox);
    },
  });
  vm.runInContext(fs.readFileSync(publicFile("sw.js"), "utf8"), sandbox);
  let pending;
  handlers.get("push")({
    data: {
      json: () => ({
        v: 2,
        kind: "session-completed",
        eventId: "c1",
        link: "/sessions/s1/chat",
        tag: "session:s1",
        count: 2,
      }),
    },
    waitUntil: (promise) => (pending = promise),
  });
  await pending;
  assert.deepEqual(closed, ["s1"]);
  assert.equal(badge, 2);
  assert.equal(shown[0].title, "AgentPier: Response ready");
  assert.equal(shown[0].tag, "session:s1");
  handlers.get("push")({
    data: { json: () => ({ v: 2, kind: "test", eventId: "t1", link: "/", count: 0 }) },
    waitUntil: (promise) => (pending = promise),
  });
  await pending;
  assert.equal(badge, 0);
});
