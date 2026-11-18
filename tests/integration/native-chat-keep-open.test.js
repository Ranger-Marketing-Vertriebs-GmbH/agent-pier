import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { keepOpenDue } from "../../server/features/assistants/chat-reconcile.js";

// Reconciliation keeps each chat's native session open (pinned) once per Gateway
// connection (chat-reconcile.js). A Gateway still preparing an agent's session rows
// after a start leaves `sessions.describe` unanswered (TIMEOUT) or UNAVAILABLE; the
// keep must back off instead of costing every pass, the 2-second poll included, one
// full call timeout per such chat, and a failure that only raced the start stays
// quiet.

const timeout = () => Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });

function runtimeFixture(describe) {
  const runtime = new EventEmitter();
  const calls = [];
  runtime.client = {
    ready: true,
    subscribe: () => () => {},
    call: async (method, params) => {
      calls.push([method, params]);
      if (method === "sessions.describe") return describe(params);
      if (method === "chat.history") return { messages: [] };
      return {};
    },
  };
  runtime.close = async () => {};
  runtime.setState = () => {};
  return { runtime, calls };
}

function serviceWith(t, describe) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-keep-open-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { runtime, calls } = runtimeFixture(describe);
  const clock = { now: 1_000_000 };
  const service = new AssistantService({
    store: new AssistantStore({ dataDir }),
    runtime,
    models: {},
    config: { apply: async () => {} },
    now: () => clock.now,
  });
  t.after(() => service.close());
  const a = service.store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = service.store.saveConversation({
    assistantId: a.id,
    runtimeSessionKey: "agent:ap-home:dashboard:one",
  });
  const describes = () => calls.filter(([method]) => method === "sessions.describe");
  return { service, chat, clock, describes };
}

function captureWarnings(t) {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  t.after(() => (console.warn = warn));
  return warnings;
}

test("a chat whose keep timed out is not asked again by every pass", async (t) => {
  const warnings = captureWarnings(t);
  const { service, chat, clock, describes } = serviceWith(t, () => {
    throw timeout();
  });
  await service.reconcile();
  assert.equal(describes().length, 1);
  // The poll's partial passes and a cancel's full pass within the back-off skip it.
  await service.reconcile({ full: false, chats: [chat.id] });
  await service.reconcile();
  clock.now += 30_000;
  await service.reconcile({ full: false, chats: [chat.id] });
  assert.equal(describes().length, 1);
  // A failure that may only have raced the Gateway's start is not logged.
  assert.deepEqual(
    warnings.filter((w) => w.includes("kept open natively")),
    [],
  );
  // Due again after a minute; a second failure is logged once, and waits longer.
  clock.now += 31_000;
  await service.reconcile({ full: false, chats: [chat.id] });
  assert.equal(describes().length, 2);
  const logged = warnings.filter((w) => w.includes("kept open natively"));
  assert.equal(logged.length, 1);
  assert.match(logged[0], new RegExp(`Agent chat ${chat.id} .*\\(TIMEOUT\\)`));
  clock.now += 61_000;
  await service.reconcile({ full: false, chats: [chat.id] });
  assert.equal(describes().length, 2);
  clock.now += 60_000;
  await service.reconcile({ full: false, chats: [chat.id] });
  assert.equal(describes().length, 3);
  assert.equal(warnings.filter((w) => w.includes("kept open natively")).length, 1);
  // The back-off is capped: a chat that never answers is still tried now and then.
  for (let n = 0; n < 12; n++) {
    clock.now += 31 * 60_000;
    await service.reconcile({ full: false, chats: [chat.id] });
  }
  assert.equal(describes().length, 15);
});

test("a chat whose keep failed recovers once the Gateway answers", async (t) => {
  captureWarnings(t);
  let ready = false;
  const { service, chat, clock, describes } = serviceWith(t, () => {
    if (!ready) throw timeout();
    return { session: { sessionId: "s1", pinned: true } };
  });
  await service.reconcile();
  ready = true;
  clock.now += 61_000;
  await service.reconcile({ full: false, chats: [chat.id] });
  assert.equal(describes().length, 2);
  assert.ok(service.keptOpen.has(chat.id));
  clock.now += 24 * 60 * 60_000;
  await service.reconcile();
  assert.equal(describes().length, 2);
});

test("the agents' admission makes a failed keep due at once", async (t) => {
  captureWarnings(t);
  let ready = false;
  const { service, chat, describes } = serviceWith(t, () => {
    if (!ready) throw timeout();
    return { session: { sessionId: "s1", pinned: true } };
  });
  await service.reconcile();
  ready = true;
  keepOpenDue(service);
  await service.reconcile();
  assert.equal(describes().length, 2);
  assert.ok(service.keptOpen.has(chat.id));
});
