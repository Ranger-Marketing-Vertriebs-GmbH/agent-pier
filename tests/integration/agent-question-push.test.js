import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { AgentApprovalEvents } from "../../server/application/agent-approval-events.js";
import {
  AgentQuestions,
  ownerQuestions,
} from "../../server/features/assistants/agent-questions.js";
import { assistantActivity } from "../../server/features/assistants/assistant-activity.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { collectItems } from "../../server/features/inbox/inbox-sources.js";
import { NotificationService } from "../../server/features/notifications/notification-service.js";

// A question an agent asks while its turn waits (agent-questions.js) reaches the person
// who can answer it as the agent's approvals do: one `agent-approval` push with the
// subject `question`, the agent's waiting state and, for the owner, an inbox item. The
// real question store, emitter and notification service run here; only the push
// transport and the runtime are replaced.

const subscription = (name) => {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    endpoint: `https://push.example.com/send/${name}`,
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
};

const chats = [
  { id: "c-owner", assistantId: "nova", runtimeSessionKey: "agent:ap-nova:main" },
  {
    id: "c-ada",
    assistantId: "desk",
    runtimeSessionKey: "agent:ap-desk:ada",
    userId: "ada",
  },
];
const agents = {
  nova: { id: "nova", name: "Nova", runtimeAgentId: "ap-nova" },
  desk: { id: "desk", name: "Desk", runtimeAgentId: "ap-desk" },
};

async function fixture(t, { questions = () => [] } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-question-push-"));
  const sent = [];
  let now = Date.parse("2026-11-27T10:00:00Z");
  const notifications = new NotificationService({
    dataDir,
    clock: { now: () => now },
    send: async (target, payload) => {
      sent.push({ to: new URL(target.endpoint).pathname.split("/").at(-1), ...payload });
    },
  });
  t.after(async () => {
    await notifications.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const device = async (name, userId = null, preferences = { level: "preview" }) => {
    const { subscription: row } = await notifications.subscribe(
      { deviceId: name, label: name, subscription: subscription(name) },
      { userId },
    );
    await notifications.setPreferences(row.id, preferences, { userId });
  };
  const changes = [];
  const assistants = {
    // The supervisor of the shared host: its client lists what the Gateway waits on.
    runtime: {
      client: {
        call: async (method) =>
          method === "question.list" ? { questions: questions() } : {},
      },
    },
    gatewayEvents: new GatewayEventHub(),
    store: {
      listConversations: () => chats,
      listAssistants: () => Object.values(agents),
      getAssistant: (id) => agents[id],
      storedConversation: (id) => chats.find((chat) => chat.id === id),
    },
    ledger: { latestRequest: () => null },
    teams: { store: { context: () => null, list: () => [] } },
    workflows: { store: { awaiting: () => [], list: () => [] } },
    channels: { store: { list: () => [] } },
    changed: (change) => changes.push(change),
  };
  assistants.questions = new AgentQuestions(assistants, { now: () => now });
  const events = new AgentApprovalEvents({ services: { assistants }, notifications });
  // What already waits when AgentPier starts never notifies late.
  await events.poll();
  return {
    assistants,
    notifications,
    events,
    sent,
    device,
    changes,
    advance: (ms) => (now += ms),
    async poll() {
      await events.poll();
      await Promise.allSettled([...notifications.active]);
    },
  };
}

const record = (id, chat, text, extra = {}) => ({
  id,
  request: {
    questions: [{ id: "answer", header: "", text, options: [], other: true }],
    agentId: agents[chat.assistantId].runtimeAgentId,
    sessionKey: chat.runtimeSessionKey,
    runId: "run-1",
  },
  createdAtMs: Date.parse("2026-11-27T10:00:00Z"),
  expiresAtMs: Date.parse("2026-11-27T10:15:00Z"),
  ...extra,
});
const ask = (f, ...args) =>
  f.assistants.gatewayEvents.deliver({
    kind: "other",
    event: "question.requested",
    payload: record(...args),
  });
const end = (f, id) =>
  f.assistants.gatewayEvents.deliver({
    kind: "other",
    event: "question.resolved",
    payload: { id, status: "answered" },
  });

test("a waiting question notifies the owner once, with the agent's name and a preview", async (t) => {
  const f = await fixture(t);
  await f.device("phone");
  await f.device("shared", null, { level: "type" });
  ask(f, "ask_1", chats[0], "Which environment should I deploy to?");
  await f.poll();
  // Asked again (a reconnect's listing, a frame sent twice) and polled again: no more.
  ask(f, "ask_1", chats[0], "Which environment should I deploy to?");
  await f.poll();
  await f.poll();
  assert.equal(f.sent.length, 2);
  const phone = f.sent.find((payload) => payload.to === "phone");
  assert.deepEqual(
    [phone.kind, phone.subject, phone.label, phone.preview, phone.link, phone.tag],
    [
      "agent-approval",
      "question",
      "Nova",
      "Which environment should I deploy to?",
      "/agents/nova/chats/c-owner",
      "chat:c-owner",
    ],
  );
  assert.equal(phone.item, "/inbox/question/ask_1");
  // A question is answered in its chat, never from the notification.
  assert.equal(phone.decide, undefined);
  // "Event type only" names neither the agent nor the question.
  const shared = f.sent.find((payload) => payload.to === "shared");
  assert.deepEqual(
    [shared.kind, shared.subject, shared.label, shared.preview],
    ["agent-approval", undefined, undefined, undefined],
  );
});

test("a restart of the question store or of the emitter does not notify again", async (t) => {
  const waiting = [];
  const f = await fixture(t, { questions: () => waiting });
  await f.device("phone");
  // The Gateway's own record of the question (openclaw-questions.js).
  waiting.push({
    id: "ask_1",
    questions: [{ questionId: "answer", header: "", question: "Ship it?", options: [] }],
    agentId: "ap-nova",
    sessionKey: chats[0].runtimeSessionKey,
    runId: "run-1",
    createdAtMs: Date.parse("2026-11-27T10:00:00Z"),
    expiresAtMs: Date.now() + 15 * 60000,
    status: "pending",
  });
  ask(f, "ask_1", chats[0], "Ship it?");
  await f.poll();
  assert.equal(f.sent.length, 1);
  // The Gateway connection came back: its listing is read again.
  await f.assistants.questions.resync();
  await f.poll();
  // AgentPier restarted while the question still waits: a new emitter and a new
  // store that takes the question up from the listing after its first poll.
  const again = new AgentApprovalEvents({
    services: { assistants: f.assistants },
    notifications: f.notifications,
  });
  f.assistants.questions = new AgentQuestions(f.assistants);
  await again.poll();
  await f.assistants.questions.resync();
  assert.equal(f.assistants.questions.waitingAll().length, 1);
  await again.poll();
  await Promise.allSettled([...f.notifications.active]);
  assert.equal(f.sent.length, 1);
});

test("a preview that looks like a secret or a command is dropped, and long ones are cut", async (t) => {
  const f = await fixture(t);
  await f.device("phone");
  ask(f, "ask_1", chats[0], "Is the token ghp_abcdefghijklmnopqrstuvwxyz012345 right?");
  ask(f, "ask_2", chats[0], `Should I ${"really ".repeat(60)}go on?`);
  await f.poll();
  const [secret, long] = ["ask_1", "ask_2"].map((id) =>
    f.sent.find((payload) => payload.item === `/inbox/question/${id}`),
  );
  assert.equal(secret.preview, undefined);
  assert.equal(secret.label, "Nova");
  assert.doesNotMatch(JSON.stringify(f.sent), /ghp_/);
  assert.equal([...long.preview].length, 140);
});

test("nobody is notified about the chat they are looking at, or with the switch off", async (t) => {
  const f = await fixture(t);
  await f.device("phone");
  await f.device("quiet", null, { events: { "agent-approval": false } });
  f.notifications.reportPresence("/agents/nova/chats/c-owner");
  ask(f, "ask_1", chats[0], "Ship it?");
  await f.poll();
  assert.equal(f.sent.length, 0);
  // Another question, once the chat is no longer on screen.
  f.advance(60000);
  ask(f, "ask_2", chats[0], "And the docs?");
  await f.poll();
  assert.deepEqual(
    f.sent.map((payload) => payload.to),
    ["phone"],
  );
});

test("a question in a user's chat goes to her devices, never to the owner's", async (t) => {
  const f = await fixture(t);
  await f.device("owner-phone");
  await f.device("ada-phone", "ada");
  await f.device("bob-phone", "bob");
  ask(f, "ask_1", chats[1], "Which invoice do you mean?");
  await f.poll();
  assert.deepEqual(
    f.sent.map((payload) => [payload.to, payload.link, payload.item]),
    [["ada-phone", "/agents/desk/chats/c-ada", undefined]],
  );
  // The owner's list and inbox do not show it either.
  assert.deepEqual(ownerQuestions(f.assistants), []);
  assert.deepEqual(await collectItems({ assistants: f.assistants }), []);
});

test("the agent waits for the owner's answer in the list and the inbox until the question ends", async (t) => {
  const f = await fixture(t);
  const activity = () =>
    assistantActivity({
      assistants: Object.values(agents),
      conversations: chats,
      latest: [{ conversationId: "c-owner", attemptState: "running" }],
      asking: f.assistants.questions.ownerAsking(),
    }).nova;
  assert.equal(activity().state, "working");
  ask(f, "ask_1", chats[0], "Which environment should I deploy to?");
  assert.deepEqual(f.changes.at(-1), { conversationId: "c-owner" });
  assert.deepEqual(
    [activity().state, activity().reason, activity().label],
    ["waiting", "question", "status.question"],
  );
  const [item] = await collectItems({ assistants: f.assistants });
  assert.deepEqual(
    [item.type, item.tab, item.kind, item.id, item.title, item.link, item.source],
    [
      "question",
      "questions",
      "agent-question",
      "ask_1",
      "Which environment should I deploy to?",
      "/agents/nova/chats/c-owner",
      { kind: "agent", id: "nova", name: "Nova" },
    ],
  );
  assert.equal(item.conversationId, "c-owner");
  assert.equal(item.questions[0].text, "Which environment should I deploy to?");
  // Answered, cancelled or timed out: the runtime ends it, and everything clears.
  const before = f.changes.length;
  end(f, "ask_1");
  assert.equal(f.changes.length, before + 1);
  assert.equal(activity().state, "working");
  assert.deepEqual(await collectItems({ assistants: f.assistants }), []);
  // A question past its time no longer waits, even before the runtime says so.
  ask(f, "ask_2", chats[0], "Still there?");
  f.advance(16 * 60000);
  assert.equal(activity().state, "working");
  assert.deepEqual(await collectItems({ assistants: f.assistants }), []);
});

test("a runtime that asks no questions notifies nobody", async (t) => {
  const f = await fixture(t);
  await f.device("phone");
  // Agent services without a question store (agents of a runtime without the port).
  delete f.assistants.questions;
  await f.poll();
  assert.deepEqual(ownerQuestions(f.assistants), []);
  assert.equal(f.sent.length, 0);
  // A host that lists no questions: nothing to take up.
  f.assistants.questions = new AgentQuestions(f.assistants);
  await f.assistants.questions.resync();
  await f.poll();
  assert.equal(f.sent.length, 0);
});
