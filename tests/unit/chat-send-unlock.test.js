import test from "node:test";
import assert from "node:assert/strict";
import { ChatDraft, deliveryScope } from "../../web/features/chat/chat-draft.js";
import { withReadyUploads } from "../../web/features/chat/chat-upload-send.js";
import { chatUploadsCopy } from "../../web/lib/i18n/messages/chat-uploads.js";

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
const scope = deliveryScope({
  id: "one",
  accountId: "a",
  tool: "claude",
  createdAt: "x",
});
const lock = (name, operation) => Promise.resolve().then(operation);

/** Web Locks subset: exclusive per name, queued requests abort through their signal. */
function lockManager() {
  const held = new Map();
  return {
    request(name, options, operation) {
      const run = async () => {
        while (held.get(name)) {
          await Promise.race([
            held.get(name),
            new Promise((_, reject) => {
              if (options.signal?.aborted) reject(new DOMException("", "AbortError"));
              options.signal?.addEventListener("abort", () =>
                reject(new DOMException("", "AbortError")),
              );
            }),
          ]);
        }
        let release;
        held.set(name, new Promise((resolve) => (release = resolve)));
        try {
          return await operation({ name });
        } finally {
          held.delete(name);
          release();
        }
      };
      return run();
    },
  };
}

test("an absent outbox never locks the chat: it can be edited and dismissed", async () => {
  const draft = new ChatDraft(storage(), scope, lock);
  await draft.change({ text: "too large for the old body limit" });
  await draft.enqueue("id", []);
  await draft.receipt({ deliveryId: "id", status: "absent" });
  assert.equal(draft.getSnapshot().outbox.status, "absent");
  await draft.restore("id");
  assert.equal(draft.getSnapshot().outbox, null);
  assert.equal(draft.getSnapshot().text, "too large for the old body limit");
  // The absent notice stays pollable in recent until the user dismisses it.
  assert.equal(draft.getSnapshot().recent[0].status, "absent");
  await draft.dismiss("id");
  assert.deepEqual(draft.getSnapshot().recent, []);
});

test("sending waits for a brief restore lock instead of reporting pending uploads", async () => {
  const locks = lockManager();
  let releaseRestore;
  const restore = locks.request(
    `agentpier.upload:${scope}`,
    {},
    () => new Promise((resolve) => (releaseRestore = resolve)),
  );
  let sent = 0;
  const sending = withReadyUploads(scope, async () => ++sent, {
    locks,
    list: async () => [],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent, 0);
  releaseRestore();
  await restore;
  assert.equal(await sending, 1);
});

test("saved recovery files or a long-held upload lock still block sending", async () => {
  const locks = lockManager();
  await assert.rejects(
    withReadyUploads(scope, async () => assert.fail("sent"), {
      locks,
      list: async () => [{ key: "file" }],
    }),
    { message: chatUploadsCopy.pendingMessage },
  );
  let releaseUpload;
  const upload = locks.request(
    `agentpier.upload:${scope}`,
    {},
    () => new Promise((resolve) => (releaseUpload = resolve)),
  );
  await assert.rejects(
    withReadyUploads(scope, async () => assert.fail("sent"), {
      locks,
      list: async () => [],
      timeoutMs: 30,
    }),
    { message: chatUploadsCopy.pendingMessage },
  );
  releaseUpload();
  await upload;
  await assert.rejects(
    withReadyUploads(scope, async () => assert.fail("sent"), {
      locks,
      list: async () => {
        throw new Error("IndexedDB unavailable");
      },
    }),
    { message: chatUploadsCopy.storageFailed },
  );
});
