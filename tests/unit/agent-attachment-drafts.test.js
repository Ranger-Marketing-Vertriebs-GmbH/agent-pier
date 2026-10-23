import test from "node:test";
import assert from "node:assert/strict";
import { AttachmentDraft } from "../../web/features/assistants/agent-attachment-drafts.js";
import {
  AssistantDrafts,
  AttachmentDrafts,
} from "../../web/features/assistants/assistant-drafts.js";

const photo = () =>
  new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });
const gone = () =>
  Object.assign(
    new Error("This attachment is no longer available. Add the file again."),
    {
      status: 404,
    },
  );

// A fake server for one chat: uploads get ids in order; `missing` ids are gone.
function server(name) {
  const calls = { uploads: [], discarded: [], kept: [], left: [] };
  const missing = new Set();
  let release = () => {};
  let hold = false;
  const transport = {
    upload: async (file, signal, progress) => {
      progress(50);
      if (hold) await new Promise((resolve) => (release = resolve));
      if (signal.aborted) throw new Error("aborted");
      calls.uploads.push(file.name);
      return { id: `${name}-${calls.uploads.length}`, name: file.name };
    },
    preview: async () => "data:image/png;base64,AAAA",
    discard: async (id) => calls.discarded.push(id),
    keep: async (id) => {
      calls.kept.push(id);
      if (missing.has(id)) throw gone();
      return { id };
    },
    leave: (id) => calls.left.push(id),
  };
  return {
    transport,
    calls,
    missing,
    hold: () => (hold = true),
    release: () => release(),
  };
}
const settled = (draft) =>
  new Promise((resolve) => {
    const check = () =>
      draft.items.every((item) => item.status !== "uploading")
        ? resolve()
        : setTimeout(check, 1);
    check();
  });

test("each chat keeps its own picked files after its composer is gone", async () => {
  const registry = new AttachmentDrafts(null);
  const dinner = server("dinner");
  const network = server("network");
  const first = registry.entry(
    "/assistant-conversations/dinner",
    () => new AttachmentDraft(dinner.transport),
  );
  first.add([photo()]);
  await settled(first);
  // The chat is left (no subscriber) and opened again: the same draft comes back.
  registry.release("/assistant-conversations/dinner");
  const again = registry.entry("/assistant-conversations/dinner", () => {
    throw new Error("a kept draft is not made anew");
  });
  assert.equal(again, first);
  assert.deepEqual(
    again.items.map(({ id, name, status, previewUrl, image }) => ({
      id,
      name,
      status,
      previewUrl,
      image,
    })),
    [
      {
        id: "dinner-1",
        name: "photo.png",
        status: "ready",
        previewUrl: "data:image/png;base64,AAAA",
        image: true,
      },
    ],
  );
  // Another chat, or another user's route for the same id, starts empty.
  const other = registry.entry(
    "/assistant-conversations/network",
    () => new AttachmentDraft(network.transport),
  );
  const hers = registry.entry(
    "/me/conversations/dinner",
    () => new AttachmentDraft(network.transport),
  );
  assert.deepEqual(other.items, []);
  assert.deepEqual(hers.items, []);
  assert.deepEqual(dinner.calls.discarded, []);
});

test("an upload running when the chat is left finishes into its draft", async () => {
  const registry = new AttachmentDrafts(null);
  const chat = server("chat");
  chat.hold();
  const draft = registry.entry("chat", () => new AttachmentDraft(chat.transport));
  const unsubscribe = draft.subscribe(() => {});
  draft.add([photo()]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(draft.items[0].status, "uploading");
  unsubscribe();
  registry.release("chat");
  chat.release();
  await settled(draft);
  assert.equal(
    registry.entry("chat", () => null),
    draft,
  );
  assert.equal(draft.items[0].id, "chat-1");
});

test("returning to a chat marks files the server no longer has, which can be removed", async () => {
  const chat = server("chat");
  const draft = new AttachmentDraft(chat.transport);
  draft.add([photo(), photo()]);
  await settled(draft);
  chat.missing.add("chat-1");
  await draft.check();
  assert.deepEqual(chat.calls.kept, ["chat-1", "chat-2"]);
  assert.deepEqual(
    draft.items.map((item) => [item.id, item.status, item.error]),
    [
      ["chat-1", "failed", "This attachment is no longer available. Add the file again."],
      ["chat-2", "ready", undefined],
    ],
  );
  draft.remove(draft.items[0].key);
  assert.deepEqual(chat.calls.discarded, ["chat-1"]);
  assert.deepEqual(
    draft.items.map((item) => item.id),
    ["chat-2"],
  );
  // A network failure says nothing about the file: it stays ready.
  chat.transport.keep = async () => {
    throw new Error("offline");
  };
  await draft.check();
  assert.equal(draft.items[0].status, "ready");
});

test("sent files leave the draft, and leaving the page or logging out forgets every chat", async () => {
  const target = new EventTarget();
  const drafts = new AssistantDrafts(new AttachmentDrafts(target));
  const one = server("one");
  const two = server("two");
  const first = drafts.attachments.entry("one", () => new AttachmentDraft(one.transport));
  const second = drafts.attachments.entry(
    "two",
    () => new AttachmentDraft(two.transport),
  );
  first.add([photo(), photo()]);
  second.add([photo()]);
  await Promise.all([settled(first), settled(second)]);
  first.sent(["one-1"]);
  assert.deepEqual(
    first.items.map((item) => item.id),
    ["one-2"],
  );
  // A reload or a closed tab discards what is still staged, for every chat.
  target.dispatchEvent(new Event("pagehide"));
  assert.deepEqual(one.calls.left, ["one-2"]);
  assert.deepEqual(two.calls.left, ["two-1"]);
  // A page restored from the back-forward cache shows no file the server dropped.
  target.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  assert.deepEqual(first.items, []);
  second.restore([{ id: "two-9", name: "notes.md", size: 3, kind: "text" }]);
  drafts.set("two", "Some text");
  drafts.clearAll();
  assert.equal(drafts.get("two"), "");
  assert.deepEqual(second.items, []);
  assert.notEqual(
    drafts.attachments.entry("two", () => new AttachmentDraft(two.transport)),
    second,
  );
});
