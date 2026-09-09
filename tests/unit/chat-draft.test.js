import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatDraft,
  deliveryScope,
  deliveryNotices,
  visibleDeliveries,
} from "../../web/features/chat/chat-draft.js";

function mutex() {
  const tails = new Map();
  return (name, operation) => {
    const result = (tails.get(name) || Promise.resolve()).then(operation);
    tails.set(
      name,
      result.catch(() => {}),
    );
    return result;
  };
}
const lock = mutex();

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
const session = { id: "one", accountId: "account", tool: "claude", createdAt: "today" };
const scope = deliveryScope(session);

test("background reload preserves unsaved draft warning until a durable write", async () => {
  const disk = storage();
  const draft = new ChatDraft(disk, scope, lock);
  const write = disk.setItem;
  disk.setItem = () => {
    throw Error("quota");
  };
  await draft.change({ text: "not durable yet" });
  assert.ok(draft.getSnapshot().storageError);
  draft.reload();
  assert.equal(draft.getSnapshot().text, "not durable yet");
  assert.ok(draft.getSnapshot().storageError);
  assert.equal(await draft.enqueue("blocked", []), null);
  disk.setItem = write;
  await draft.change({ text: "saved now" });
  assert.equal(draft.getSnapshot().storageError, "");
  assert.equal(new ChatDraft(disk, scope, lock).getSnapshot().text, "saved now");
});

test("draft restores text and completed uploads without persisting image payloads", async () => {
  const disk = storage();
  const draft = new ChatDraft(disk, scope, lock);
  await draft.change({
    text: "not sent",
    attachments: [
      {
        key: "a",
        name: "a.png",
        path: "/a",
        previewUrl: "data:image/png;base64,private",
      },
    ],
  });
  await draft.change({ text: "not sent" });
  assert.ok(draft.getSnapshot().attachments[0].previewUrl);
  const restored = new ChatDraft(disk, scope, lock).getSnapshot();
  assert.equal(restored.text, "not sent");
  assert.equal(restored.attachments[0].path, "/a");
  assert.equal(restored.attachments[0].previewUrl, undefined);
  assert.equal(
    new ChatDraft(disk, deliveryScope({ ...session, accountId: "other" })).getSnapshot()
      .text,
    "",
  );
});

test("outbox survives reload with the exact same identity and blocks mutation", async () => {
  const disk = storage();
  const draft = new ChatDraft(disk, scope, lock);
  await draft.change({ text: "send me" });
  const pending = await draft.enqueue("message-id", []);
  await draft.change({ text: "changed" });
  const restored = new ChatDraft(disk, scope, lock);
  assert.equal(restored.getSnapshot().text, "send me");
  assert.equal(restored.getSnapshot().outbox.id, pending.id);
  assert.equal(restored.getSnapshot().outbox.text, "send me");
  await restored.receipt({ deliveryId: pending.id, status: "handed-off" });
  const accepted = new ChatDraft(disk, scope, lock).getSnapshot();
  assert.equal(accepted.outbox, null);
  assert.equal(accepted.text, "");
  assert.equal(accepted.recent[0].text, "send me");
  assert.ok(Number.isFinite(Date.parse(accepted.recent[0].clientCreatedAt)));
});

test("failed persistence cannot produce a sendable outbox; corrupt records stay intact", async () => {
  const disk = storage();
  const draft = new ChatDraft(disk, scope, lock);
  await draft.change({ text: "keep me" });
  disk.setItem = () => {
    throw Error("quota");
  };
  assert.equal(await draft.enqueue("id", []), null);
  assert.equal(draft.getSnapshot().text, "keep me");
  assert.ok(draft.getSnapshot().storageError);
  assert.equal(draft.getSnapshot().outbox, null);
  const corrupt = new ChatDraft(
    { getItem: () => "broken", setItem: () => assert.fail("must not overwrite") },
    scope,
    lock,
  );
  assert.equal(await corrupt.enqueue("id", []), null);
  assert.ok(corrupt.getSnapshot().storageError);
});

test("optimistic display consumes only new matching user rows once and never treats text as delivery ACK", async () => {
  const a = { id: "a", text: "same", baselineIds: ["old"] };
  const b = { id: "b", text: "same", baselineIds: ["old"] };
  const rows = [
    { id: "old", role: "user", text: "same" },
    { id: "new", role: "user", text: "same" },
  ];
  assert.deepEqual(
    visibleDeliveries([a, b], rows).map((item) => item.id),
    ["b"],
  );
  assert.deepEqual(
    visibleDeliveries([a], [{ id: "new", role: "assistant", text: "same" }]),
    [a],
  );
});

test("concurrent tabs preserve one outbox despite stale typing and late receipts", async () => {
  const disk = storage();
  const sharedLock = mutex();
  const a = new ChatDraft(disk, scope, sharedLock);
  await a.change({ text: "send once" });
  const b = new ChatDraft(disk, scope, sharedLock);
  const [first, , second] = await Promise.all([
    a.enqueue("first", []),
    b.change({ text: "stale typing" }),
    b.enqueue("second", []),
  ]);
  assert.equal(first.id, "first");
  assert.equal(second.id, "first");
  assert.equal(new ChatDraft(disk, scope).getSnapshot().outbox.id, "first");
  await a.receipt({ deliveryId: "first", status: "handed-off" });
  await a.change({ text: "next message" });
  await a.enqueue("next", []);
  await b.receipt({ deliveryId: "first", status: "handed-off" });
  await b.restore("first");
  await b.dismiss("first");
  const saved = new ChatDraft(disk, scope).getSnapshot();
  assert.equal(saved.outbox.id, "next");
  assert.equal(saved.outbox.text, "next message");
});

test("failed typing writes retain exact text for later durable enqueue", async () => {
  const disk = storage();
  const draft = new ChatDraft(disk, scope, lock);
  await draft.change({ text: "older" });
  const write = disk.setItem;
  disk.setItem = () => {
    throw Error("quota");
  };
  await draft.change({ text: "unsaved newest" });
  assert.equal(draft.getSnapshot().text, "unsaved newest");
  assert.equal(await draft.enqueue("failed", []), null);
  disk.setItem = write;
  assert.equal((await draft.enqueue("saved", [])).text, "unsaved newest");
});

test("missing cross-tab lock fails closed", async () => {
  const disk = storage();
  const draft = new ChatDraft(disk, scope);
  await draft.change({ text: "must stay local" });
  assert.equal(await draft.enqueue("id", []), null);
  assert.ok(draft.getSnapshot().storageError);
  assert.equal(disk.getItem(draft.key), null);
});

test("mutation detects corruption introduced after construction without overwriting it", async () => {
  const disk = storage();
  const draft = new ChatDraft(disk, scope, lock);
  await draft.change({ text: "keep" });
  disk.setItem(draft.key, "broken");
  await draft.change({ text: "must not overwrite" });
  assert.equal(await draft.enqueue("id", []), null);
  assert.equal(disk.getItem(draft.key), "broken");
  assert.ok(draft.getSnapshot().storageError);
});

test("only the current uncertain or rejected outbox can return to draft", async () => {
  const disk = storage();
  const draft = new ChatDraft(disk, scope, lock);
  await draft.change({ text: "restore me" });
  await draft.enqueue("id", []);
  await draft.restore("id");
  assert.equal(draft.getSnapshot().outbox.id, "id");
  await draft.receipt({ deliveryId: "id", status: "uncertain" });
  await draft.restore("wrong");
  assert.equal(draft.getSnapshot().outbox.id, "id");
  await draft.restore("id");
  assert.equal(draft.getSnapshot().outbox, null);
  assert.equal(draft.getSnapshot().text, "restore me");
});

test("typing publishes immediately and older locked commits cannot revert newer input", async () => {
  const disk = storage();
  const operations = [];
  const heldLock = (_name, operation) =>
    new Promise((resolve) => {
      operations.push(() => resolve(operation()));
    });
  const draft = new ChatDraft(disk, scope, heldLock);
  const first = draft.change({ text: "a" });
  assert.equal(draft.getSnapshot().text, "a");
  const second = draft.change({ text: "ab" });
  assert.equal(draft.getSnapshot().text, "ab");
  operations.shift()();
  await first;
  assert.equal(draft.getSnapshot().text, "ab");
  assert.equal(JSON.parse(disk.getItem(draft.key)).text, "ab");
  operations.shift()();
  await second;
  assert.equal(draft.getSnapshot().text, "ab");
  assert.equal(JSON.parse(disk.getItem(draft.key)).text, "ab");
});

test("immediate reload recovers text and attachment journal before any shared lock runs", async () => {
  const disk = storage();
  const operations = [];
  const held = (_name, operation) =>
    new Promise((resolve) => operations.push(() => resolve(operation())));
  const draft = new ChatDraft(disk, scope, held);
  const first = draft.change({ text: "Schnell " });
  const second = draft.change({
    text: "Schnell getippt, vollständig gespeichert.",
    attachments: [{ key: "a", name: "a.png", path: "/a", previewUrl: "private" }],
  });
  const recovered = new ChatDraft(disk, scope, lock);
  assert.equal(recovered.getSnapshot().text, "Schnell getippt, vollständig gespeichert.");
  assert.equal(recovered.getSnapshot().attachments[0].path, "/a");
  assert.equal(recovered.getSnapshot().attachments[0].previewUrl, undefined);
  const sent = await recovered.enqueue("sent", []);
  await recovered.receipt({ deliveryId: sent.id, status: "handed-off" });
  while (operations.length) operations.shift()();
  await Promise.all([first, second]);
  assert.equal(new ChatDraft(disk, scope).getSnapshot().text, "");
  assert.equal(disk.length, 1);
});

test("text edits in a stale tab preserve a concurrently completed attachment before reload", async () => {
  const disk = storage();
  const uploader = new ChatDraft(disk, scope, lock);
  const operations = [];
  const typing = new ChatDraft(
    disk,
    scope,
    (_name, operation) =>
      new Promise((resolve) => operations.push(() => resolve(operation()))),
  );
  const attachment = { key: "/uploaded", name: "uploaded.png", path: "/uploaded" };
  await uploader.mutate((saved) =>
    uploader.write({ ...saved, attachments: [attachment] }),
  );
  assert.deepEqual(typing.getSnapshot().attachments, []);
  const changed = typing.change({ text: "new text" });
  assert.equal(typing.getSnapshot().text, "new text");
  assert.deepEqual(typing.getSnapshot().attachments, [attachment]);
  assert.deepEqual(new ChatDraft(disk, scope, lock).getSnapshot().attachments, [
    attachment,
  ]);
  operations.shift()();
  await changed;
  assert.deepEqual(new ChatDraft(disk, scope, lock).getSnapshot().attachments, [
    attachment,
  ]);
});

test("a failed text write does not claim ownership of attachments added by another tab", async () => {
  const disk = storage();
  const typing = new ChatDraft(disk, scope, lock);
  const uploader = new ChatDraft(disk, scope, lock);
  const write = disk.setItem;
  disk.setItem = () => {
    throw Error("quota");
  };
  await typing.change({ text: "unsaved text" });
  disk.setItem = write;
  const attachment = { key: "/uploaded", name: "uploaded.txt", path: "/uploaded" };
  await uploader.mutate((saved) =>
    uploader.write({ ...saved, attachments: [attachment] }),
  );
  const outbox = await typing.enqueue("with-upload", []);
  assert.equal(outbox.text, "unsaved text\n/uploaded");
});

test("matched delivery cards stay hidden after native history eviction and reload", async () => {
  const disk = storage();
  const draft = new ChatDraft(disk, scope, lock);
  await draft.change({ text: "older prompt" });
  await draft.enqueue("older", []);
  await draft.receipt({ deliveryId: "older", status: "handed-off" });
  const rows = [{ id: "native-old", role: "user", text: "older prompt" }];
  assert.deepEqual(visibleDeliveries(draft.getSnapshot().recent, rows), []);
  await draft.observeMessages(rows);
  const restored = new ChatDraft(disk, scope, lock);
  assert.deepEqual(visibleDeliveries(restored.getSnapshot().recent, []), []);
  assert.equal(restored.getSnapshot().recent[0].status, "handed-off");
  assert.equal(restored.getSnapshot().recent[0].text, "older prompt");

  await restored.change({ text: "older prompt" });
  await restored.enqueue("newer", []);
  await restored.receipt({ deliveryId: "newer", status: "handed-off" });
  await restored.observeMessages(rows);
  assert.deepEqual(
    visibleDeliveries(restored.getSnapshot().recent, rows).map((item) => item.id),
    ["newer"],
  );
  await restored.observeMessages([
    ...rows,
    { id: "native-new", role: "user", text: "older prompt" },
  ]);
  assert.deepEqual(visibleDeliveries(restored.getSnapshot().recent, []), []);
  assert.equal(restored.getSnapshot().recent[1].matchedMessageId, "native-new");
  await restored.change({ text: "uncertain prompt" });
  await restored.enqueue("uncertain", []);
  await restored.receipt({ deliveryId: "uncertain", status: "uncertain" });
  await restored.observeMessages([
    { id: "native-uncertain", role: "user", text: "uncertain prompt" },
  ]);
  assert.equal(restored.getSnapshot().outbox.status, "uncertain");
  assert.equal(restored.getSnapshot().outbox.matchedMessageId, undefined);
});

test("saved handed-off notices are grouped separately from current delivery without inferring age or acknowledgement", () => {
  const old = { id: "old", status: "handed-off", text: "old prompt", baselineIds: [] };
  const ambiguous = {
    id: "ambiguous",
    status: "uncertain",
    text: "review",
    baselineIds: [],
  };
  const pending = {
    id: "pending",
    status: "uncertain",
    text: "new prompt",
    baselineIds: [],
  };
  const matched = {
    id: "matched",
    status: "handed-off",
    text: "seen",
    baselineIds: [],
    matchedMessageId: "native",
  };
  const fresh = {
    ...old,
    id: "fresh-handoff",
    clientCreatedAt: "2026-09-09T05:00:00.000Z",
  };
  const delivery = { recent: [old, ambiguous, matched, fresh], outbox: pending };
  const messages = [{ id: "fresh", role: "assistant", text: "fresh response" }];
  const before = JSON.stringify(delivery);
  assert.deepEqual(deliveryNotices(delivery, messages, "earlier"), [old]);
  assert.deepEqual(deliveryNotices(delivery, messages), [ambiguous, fresh, pending]);
  assert.equal(JSON.stringify(delivery), before);
});

test("observing delivery history preserves unsaved typing and its warning", async () => {
  const disk = storage();
  const draft = new ChatDraft(disk, scope, lock);
  await draft.change({ text: "older prompt" });
  await draft.enqueue("older", []);
  await draft.receipt({ deliveryId: "older", status: "handed-off" });
  const write = disk.setItem;
  disk.setItem = () => {
    throw Error("quota");
  };
  await draft.change({ text: "unsaved draft" });
  assert.equal(draft.getSnapshot().text, "unsaved draft");
  assert.ok(draft.getSnapshot().storageError);
  disk.setItem = write;
  await draft.observeMessages([{ id: "native", role: "user", text: "older prompt" }]);
  assert.equal(draft.getSnapshot().text, "unsaved draft");
  assert.ok(draft.getSnapshot().storageError);
  assert.equal(draft.getSnapshot().recent[0].matchedMessageId, "native");
  draft.reload();
  assert.equal(draft.getSnapshot().text, "unsaved draft");
  assert.ok(draft.getSnapshot().storageError);
  await draft.change({ text: "saved now" });
  assert.equal(draft.getSnapshot().storageError, "");
  assert.equal(new ChatDraft(disk, scope, lock).getSnapshot().text, "saved now");
});

test("dismissing a saved notice preserves unsaved typing and its warning", async () => {
  const disk = storage();
  const draft = new ChatDraft(disk, scope, lock);
  await draft.change({ text: "older prompt" });
  await draft.enqueue("older", []);
  await draft.receipt({ deliveryId: "older", status: "handed-off" });
  const write = disk.setItem;
  disk.setItem = () => {
    throw Error("quota");
  };
  await draft.change({ text: "unsaved draft" });
  disk.setItem = write;
  await draft.dismiss("older");
  assert.equal(draft.getSnapshot().text, "unsaved draft");
  assert.ok(draft.getSnapshot().storageError);
  assert.deepEqual(draft.getSnapshot().recent, []);
});
