import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatDraft,
  deliveryNotices,
  deliveryScope,
} from "../../web/features/chat/chat-draft.js";
import {
  ASK_AFTER_MS,
  COMMAND_NOTICE_MS,
  deliveryView,
  nextDeliveryChange,
} from "../../web/features/chat/delivery-confirmation.js";
import { nativeDeliveryStates } from "../../web/features/chat/native-delivery-state.js";

function storage() {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
const lock = (_name, operation) => Promise.resolve().then(operation);
const scope = deliveryScope({
  id: "one",
  accountId: "a",
  tool: "claude",
  createdAt: "x",
});

async function handedOff(id = "first", extra = {}) {
  const draft = new ChatDraft(storage(), scope, lock);
  await draft.change({ text: "hello" });
  await draft.enqueue(id, []);
  await draft.receipt({
    deliveryId: id,
    status: "handed-off",
    confirmation: "events",
    submittedAt: 1000,
    ...extra,
  });
  return draft;
}

test("an events delivery reads as sent, then asks after eight seconds", () => {
  const item = { status: "handed-off", confirmation: "events", submittedAt: 1000 };
  assert.equal(deliveryView(item, 1000), "handed-off");
  assert.equal(deliveryView(item, 1000 + ASK_AFTER_MS - 1), "handed-off");
  assert.equal(deliveryView(item, 1000 + ASK_AFTER_MS), "askCheck");
  assert.equal(nextDeliveryChange([item], 3000), ASK_AFTER_MS - 2000);
  assert.equal(nextDeliveryChange([item], 1000 + ASK_AFTER_MS), null);
  // A browser clock behind the server never waits longer than the full delay.
  assert.equal(nextDeliveryChange([item], 0), ASK_AFTER_MS);
  assert.equal(deliveryView({ ...item, confirmation: "screen" }, 99999), "askCheck");
});

test("text-confirmed and older receipts keep today's presentation", () => {
  for (const confirmation of ["text", undefined]) {
    const item = { status: "handed-off", confirmation, submittedAt: 1000 };
    assert.equal(deliveryView(item, 1000 + ASK_AFTER_MS * 10), null);
    assert.equal(nextDeliveryChange([item], 1000), null);
  }
  assert.equal(deliveryView({ status: "uncertain" }, 0), null);
  assert.equal(deliveryView({ status: "rejected", reason: "CHAT_QUEUED" }, 0), null);
});

test("an accepted message shows no notice; a command shows handed over briefly", () => {
  assert.equal(
    deliveryView({ status: "accepted", acceptedAt: 1000 }, 999999),
    "accepted",
  );
  const command = { status: "accepted", command: true, acceptedAt: 1000 };
  assert.equal(deliveryView(command, 1000), "commandHandedOff");
  assert.equal(nextDeliveryChange([command], 2000), COMMAND_NOTICE_MS - 1000);
  assert.equal(deliveryView(command, 1000 + COMMAND_NOTICE_MS), "hidden");
});

test("hook blocks read as blocked, with the text in the CLI or released", () => {
  assert.equal(
    deliveryView({ status: "rejected", reason: "CHAT_HOOK_BLOCKED" }, 0),
    "hookBlocked",
  );
  assert.equal(
    deliveryView({ status: "rejected", reason: "CHAT_HOOK_BLOCKED_DRAFT" }, 0),
    "hookBlockedDraft",
  );
});

test("a handed-off delivery takes its later acceptance and keeps the timing", async () => {
  const draft = await handedOff("first", { command: true });
  const sent = draft.getSnapshot().recent[0];
  assert.equal(sent.confirmation, "events");
  assert.equal(sent.submittedAt, 1000);
  assert.equal(sent.command, true);
  await draft.receipt({
    deliveryId: "first",
    status: "accepted",
    confirmation: "events",
    command: true,
    submittedAt: 1000,
    acceptedAt: 1200,
  });
  const accepted = draft.getSnapshot().recent[0];
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.acceptedAt, 1200);
  // Accepted is terminal: a late handed-off read cannot roll it back.
  await draft.receipt({ deliveryId: "first", status: "handed-off" });
  assert.equal(draft.getSnapshot().recent[0].status, "accepted");
  // Like a finished handoff, it is no notice once its transcript row exists.
  const matched = { ...accepted, matchedMessageId: "native" };
  const messages = [{ id: "native", role: "user", text: "hello" }];
  assert.deepEqual(deliveryNotices({ recent: [matched], outbox: null }, messages), []);
});

test("a hook block reaches a handed-off delivery with its reason and release", async () => {
  const draft = await handedOff();
  await draft.receipt({
    deliveryId: "first",
    status: "rejected",
    reason: "CHAT_HOOK_BLOCKED_DRAFT",
    released: false,
    hookReason: "Secrets are not allowed",
  });
  const blocked = draft.getSnapshot().recent[0];
  assert.equal(blocked.status, "rejected");
  assert.equal(blocked.reason, "CHAT_HOOK_BLOCKED_DRAFT");
  assert.equal(blocked.hookReason, "Secrets are not allowed");
  // Its text is still in the CLI prompt: the chat must not offer it again.
  assert.equal(blocked.released, false);
  await draft.reuse("first");
  assert.equal(draft.getSnapshot().text, "");

  const released = await handedOff("second");
  await released.receipt({
    deliveryId: "second",
    status: "rejected",
    reason: "CHAT_HOOK_BLOCKED",
    released: true,
  });
  assert.equal(released.getSnapshot().recent[0].released, true);
  await released.reuse("second");
  assert.equal(released.getSnapshot().text, "hello");
});

test("accepted deliveries are pruned like finished handoffs", async () => {
  const draft = new ChatDraft(storage(), scope, lock);
  for (let index = 0; index < 22; index++) {
    await draft.change({ text: `message ${index}` });
    await draft.enqueue(`m${index}`, []);
    await draft.receipt({ deliveryId: `m${index}`, status: "accepted", acceptedAt: 1 });
  }
  const recent = draft.getSnapshot().recent;
  assert.equal(recent.length, 20);
  assert.equal(recent[0].id, "m2");
});

test("native text evidence is not used for event-confirmed deliveries", () => {
  const item = {
    id: "first",
    status: "handed-off",
    confirmation: "events",
    text: "hello",
    baselineIds: [],
    observation: { generation: 1, hash: "h", startedAt: 0, baseline: [] },
  };
  const input = { generation: 1, queue: ["h"] };
  assert.equal(nativeDeliveryStates([item], [], input, "codex").size, 0);
  const legacy = { ...item, confirmation: "text" };
  assert.equal(
    nativeDeliveryStates([legacy], [], input, "codex").get("first").state,
    "nativeQueued",
  );
});

test("every shown confirmation view has German and English copy", async () => {
  const views = [
    "commandHandedOff",
    "handed-off",
    "askCheck",
    "hookBlocked",
    "hookBlockedDraft",
  ];
  for (const lang of ["de", "en"]) {
    const { chatDeliveryCopy } = await import(`../../web/lib/i18n/${lang}/chat.js`);
    for (const view of views) assert.equal(typeof chatDeliveryCopy[view], "string", view);
  }
});
