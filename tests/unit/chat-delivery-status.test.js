import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  ChatDraft,
  deliveryNotices,
  deliveryScope,
} from "../../web/features/chat/chat-draft.js";
import {
  ASK_AFTER_MS,
  COMMAND_NOTICE_MS,
  REREAD_AFTER_ASK_MS,
  deliveryView,
  followDeliveryClock,
  nextDeliveryChange,
  rereadable,
  sendHeld,
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
  const item = { status: "handed-off", confirmation: "events", handedOffAt: 1000 };
  assert.equal(deliveryView(item, 1000), "handed-off");
  assert.equal(deliveryView(item, 1000 + ASK_AFTER_MS - 1), "handed-off");
  assert.equal(deliveryView(item, 1000 + ASK_AFTER_MS), "askCheck");
  assert.equal(nextDeliveryChange([item], 3000), ASK_AFTER_MS - 2000);
  assert.equal(nextDeliveryChange([item], 1000 + ASK_AFTER_MS), null);
  // A browser clock set back never waits longer than the full delay.
  assert.equal(nextDeliveryChange([item], 0), ASK_AFTER_MS);
  assert.equal(deliveryView({ ...item, confirmation: "screen" }, 99999), "askCheck");
});

test("the ask is timed from this browser's handoff, not the server clock", async () => {
  // Server clock a minute ahead of and behind the browser.
  for (const skew of [60000, -60000]) {
    const draft = await handedOff("first", { submittedAt: Date.now() + skew });
    const item = draft.getSnapshot().recent[0];
    assert.ok(Math.abs(item.handedOffAt - Date.now()) < 1000);
    assert.equal(deliveryView(item, Date.now()), "handed-off");
    assert.equal(deliveryView(item, item.handedOffAt + ASK_AFTER_MS), "askCheck");
    // A repeated read of the same handoff keeps the first stamp.
    await draft.receipt({
      deliveryId: "first",
      status: "handed-off",
      confirmation: "events",
    });
    assert.equal(draft.getSnapshot().recent[0].handedOffAt, item.handedOffAt);
  }
});

test("the clock re-arms by itself and reaches the ask without other renders", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    const items = [
      { status: "accepted", command: true, acceptedAt: 0 },
      { status: "handed-off", confirmation: "events", handedOffAt: 0 },
    ];
    const views = [];
    const stop = followDeliveryClock(
      () => items,
      () => views.push(items.map((item) => deliveryView(item, Date.now()))),
    );
    mock.timers.tick(COMMAND_NOTICE_MS + 50);
    assert.deepEqual(views, [["accepted", "handed-off"]]);
    mock.timers.tick(ASK_AFTER_MS - COMMAND_NOTICE_MS);
    assert.deepEqual(views.at(-1), ["accepted", "askCheck"]);
    mock.timers.tick(ASK_AFTER_MS * 10);
    assert.equal(views.length, 2);
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("a live change re-reads a silent handoff until a minute after its ask", () => {
  const item = { status: "handed-off", confirmation: "events", handedOffAt: 0 };
  assert.equal(rereadable(item, ASK_AFTER_MS), true);
  assert.equal(rereadable(item, ASK_AFTER_MS + REREAD_AFTER_ASK_MS - 1), true);
  assert.equal(rereadable(item, ASK_AFTER_MS + REREAD_AFTER_ASK_MS), false);
  assert.equal(rereadable({ ...item, matchedMessageId: "row" }, 0), false);
  assert.equal(rereadable({ ...item, confirmation: "text" }, 0), false);
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
  // Only the notice ends; the sent message stays until its transcript row shows.
  assert.equal(deliveryView(command, 1000 + COMMAND_NOTICE_MS), "accepted");
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

test("a server-accepted message always gets the accepted badge", () => {
  const item = {
    id: "first",
    status: "accepted",
    confirmation: "events",
    acceptedAt: 1,
    text: "hello",
    baselineIds: [],
  };
  const row = { id: "row", role: "user", text: "hello", timestamp: 5 };
  // No native input, a stopped session and no text observation: still accepted.
  assert.deepEqual(nativeDeliveryStates([item], [], null, "claude", false).get("first"), {
    state: "nativeAccepted",
    messageId: null,
  });
  // Placed at the matched native row, like the text-based fallback.
  assert.deepEqual(nativeDeliveryStates([item], [row], null, "codex").get("first"), {
    state: "nativeAccepted",
    messageId: "row",
  });
  const saved = { ...item, matchedMessageId: "row" };
  assert.equal(
    nativeDeliveryStates([saved], [], null, "claude").get("first").messageId,
    "row",
  );
  // A local command keeps its brief notice and gets no badge.
  assert.equal(
    nativeDeliveryStates([{ ...item, command: true }], [row], null, "claude").size,
    0,
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

test("a hook block of the outbox with its text still in the CLI holds sending", async () => {
  const draft = new ChatDraft(storage(), scope, lock);
  await draft.change({ text: "hello" });
  await draft.enqueue("first", []);
  const blocked = {
    deliveryId: "first",
    status: "rejected",
    reason: "CHAT_HOOK_BLOCKED_DRAFT",
    released: false,
  };
  await draft.receipt(blocked);
  // The composer has the text back, and the CLI prompt may hold it too.
  assert.equal(draft.getSnapshot().text, "hello");
  assert.equal(sendHeld(draft.getSnapshot()), true);
  await draft.receipt(blocked);
  assert.equal(sendHeld(draft.getSnapshot()), true);
  // Released once the server reports the CLI prompt empty.
  await draft.receipt({ ...blocked, reason: "CHAT_HOOK_BLOCKED", released: true });
  assert.equal(sendHeld(draft.getSnapshot()), false);

  // A block after the handoff leaves the composer empty: nothing to double.
  const later = await handedOff("third");
  await later.receipt({ ...blocked, deliveryId: "third" });
  assert.equal(sendHeld(later.getSnapshot()), false);
});

async function heldDraft(text = "hello") {
  const draft = new ChatDraft(storage(), scope, lock);
  await draft.change({ text });
  await draft.enqueue("first", []);
  await draft.receipt({
    deliveryId: "first",
    status: "rejected",
    reason: "CHAT_HOOK_BLOCKED_DRAFT",
    released: false,
  });
  return draft;
}

test("dismissing a held block clears its composer copy, so it is never sent twice", async () => {
  const draft = await heldDraft();
  assert.equal(sendHeld(draft.getSnapshot()), true);
  await draft.dismiss("first");
  const after = new ChatDraft(draft.storage, scope, lock).getSnapshot();
  assert.equal(after.text, "");
  assert.deepEqual(after.recent, []);
  assert.equal(sendHeld(after), false);
  // Nothing is left that a send could carry.
  assert.equal(await draft.enqueue("second", []), null);
});

test("once the owner edits the held text, it may be sent and dismiss keeps it", async () => {
  const draft = await heldDraft();
  await draft.change({ text: "hello, without the secret" });
  assert.equal(sendHeld(draft.getSnapshot()), false);
  await draft.dismiss("first");
  assert.equal(draft.getSnapshot().text, "hello, without the secret");
  // Typing it back exactly holds sending again.
  const back = await heldDraft();
  await back.change({ text: "changed" });
  await back.change({ text: "hello" });
  assert.equal(sendHeld(back.getSnapshot()), true);
});
