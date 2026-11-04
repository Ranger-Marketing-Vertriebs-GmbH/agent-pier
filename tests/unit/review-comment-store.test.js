import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_COMMENT_BYTES,
  MAX_OPEN_COMMENTS,
  MAX_RESOLVED_COMMENTS,
  ReviewCommentStore,
} from "../../server/features/changes/review-comment-store.js";
import { commentInput } from "../../server/features/changes/review-comment-input.js";

const scope = { kind: "session", id: "s1" };
const anchor = {
  side: "new",
  line: 3,
  text: "return ok();",
  before: ["a"],
  after: ["b"],
  excerpt: [{ kind: "add", text: "return ok();" }],
};
const valid = (extra = {}) => ({
  workspace: "",
  file: "server/a.js",
  side: "new",
  line: 3,
  anchor,
  body: "note",
  ...extra,
});
const input = (extra = {}) => commentInput(valid(extra), { kind: "session" });

function fresh(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-review-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: new ReviewCommentStore({ dataDir, ...options }) };
}

test("create, list, edit, resolve and delete", (t) => {
  const changes = [];
  const { store } = fresh(t, { onChange: (s) => changes.push(s) });
  const c = store.create(scope, input({ body: "Use **verify**." }));
  assert.equal(c.status, "open");
  assert.equal(c.sentIn, null);
  assert.equal(store.update(scope, c.id, { status: "resolved" }).status, "resolved");
  assert.equal(store.update(scope, c.id, { body: "edited" }).body, "edited");
  store.remove(scope, c.id);
  assert.deepEqual(store.list(scope), { comments: [], batches: 0 });
  assert.equal(changes.length, 4);
  assert.deepEqual(changes[0], scope);
});

test("sent comments name their batch and stay open", (t) => {
  const { store } = fresh(t);
  const [a, b] = [store.create(scope, input()), store.create(scope, input())];
  assert.deepEqual(store.markSent(scope, [a.id, b.id]), { batch: 1 });
  assert.deepEqual(store.markSent(scope, [a.id]), { batch: 2 });
  assert.deepEqual(
    store.list(scope).comments.map((c) => [c.status, c.sentIn]),
    [
      ["open", 2],
      ["open", 1],
    ],
  );
});

test("an empty send names no batch", (t) => {
  const changes = [];
  const { store } = fresh(t, { onChange: (s) => changes.push(s) });
  store.create(scope, input());
  assert.deepEqual(store.markSent(scope, []), { batch: 0 });
  assert.equal(store.list(scope).batches, 0);
  assert.equal(store.list(scope).comments[0].sentIn, null);
  assert.equal(changes.length, 1);
});

test("limits: body bytes and open count", (t) => {
  const { store } = fresh(t);
  assert.equal(MAX_COMMENT_BYTES, 8192);
  assert.throws(() => store.create(scope, input({ body: "ä".repeat(4097) })), {
    status: 400,
  });
  store.create(scope, input({ body: "ä".repeat(4096) }));
  for (let i = 1; i < MAX_OPEN_COMMENTS; i++) store.create(scope, input());
  assert.throws(() => store.create(scope, input()), { status: 409 });
});

test("resolving past the limit drops the oldest resolved comments", (t) => {
  let tick = 0;
  const { store } = fresh(t, { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
  const ids = [];
  for (let i = 0; i < MAX_RESOLVED_COMMENTS + 1; i++) {
    if (i % 150 === 0 && i > 0) {
      for (const id of ids.slice(i - 150))
        store.update(scope, id, { status: "resolved" });
    }
    ids.push(store.create(scope, input()).id);
  }
  for (const id of ids) {
    if (store.list(scope).comments.some((c) => c.id === id))
      store.update(scope, id, { status: "resolved" });
  }
  const { comments } = store.list(scope);
  assert.ok(comments.length <= MAX_RESOLVED_COMMENTS);
  assert.ok(comments.every((c) => c.status === "resolved"));
  assert.ok(!comments.some((c) => c.id === ids[0]), "the oldest resolved is dropped");
  assert.ok(
    comments.some((c) => c.id === ids.at(-1)),
    "the newest stays",
  );
});

test("input refuses unsafe workspaces, files and anchors", () => {
  for (const workspace of ["/abs", "a\\b", "./a", "a//b", "x".repeat(513)])
    assert.throws(() => commentInput(valid({ workspace }), { kind: "session" }), {
      status: 400,
    });
  for (const file of ["", "../x", "/abs", "a\\b", "a/./b", "x".repeat(4097)])
    assert.throws(() => commentInput(valid({ file }), { kind: "session" }), {
      status: 400,
    });
  assert.throws(() => commentInput(valid({ workspace: "w" }), { kind: "run" }), {
    status: 400,
  });
  assert.equal(
    commentInput(valid({ workspace: "w/sub" }), { kind: "session" }).workspace,
    "w/sub",
  );
  const bad = [
    { ...anchor, before: ["a", "b", "c"] },
    { ...anchor, text: "x".repeat(1001) },
    { ...anchor, after: ["x".repeat(1001)] },
    { ...anchor, excerpt: Array(4).fill({ kind: "add", text: "x" }) },
    { ...anchor, excerpt: [{ kind: "meta", text: "x" }] },
    { ...anchor, excerpt: [{ kind: "add", text: "x".repeat(201) }] },
    { ...anchor, side: "left" },
    null,
  ];
  for (const a of bad)
    assert.throws(() => commentInput(valid({ anchor: a }), { kind: "run" }), {
      status: 400,
    });
  for (const extra of [{ side: "left" }, { line: 0 }, { line: 1.5 }, { body: "  " }])
    assert.throws(() => commentInput(valid(extra), { kind: "run" }), { status: 400 });
  const ok = commentInput(valid({ anchor: { ...anchor, text: "x".repeat(1000) } }), {
    kind: "run",
  });
  assert.equal(ok.anchor.text.length, 1000);
});

test("interleaved writes keep every comment", async (t) => {
  const { store, dataDir } = fresh(t);
  const [one, two] = await Promise.all([
    (async () => store.create(scope, input()))(),
    (async () => store.create(scope, input()))(),
  ]);
  await Promise.all(Array.from({ length: 20 }, async () => store.create(scope, input())));
  assert.equal(new ReviewCommentStore({ dataDir }).list(scope).comments.length, 22);
  store.remove(scope, one.id);
  assert.throws(() => store.update(scope, one.id, { body: "x" }), { status: 404 });
  assert.throws(() => store.remove(scope, one.id), { status: 404 });
  assert.equal(
    store.list(scope).comments.some((c) => c.id === two.id),
    true,
  );
});

test("discard removes the scope's file; scopes never mix", (t) => {
  const { store } = fresh(t);
  store.create(scope, input());
  store.create({ kind: "run", id: "s1" }, commentInput(valid(), { kind: "run" }));
  store.discard(scope);
  assert.deepEqual(store.list(scope).comments, []);
  assert.equal(store.list({ kind: "run", id: "s1" }).comments.length, 1);
  store.discard(scope);
});

test("scope ids are validated", (t) => {
  const { store } = fresh(t);
  assert.throws(() => store.list({ kind: "session", id: "../x" }), { status: 400 });
  assert.throws(() => store.list({ kind: "other", id: "a" }), { status: 400 });
});

test("discardQuietly logs a failing removal instead of throwing", (t) => {
  const { store } = fresh(t);
  const warn = t.mock.method(console, "warn", () => {});
  t.mock.method(store, "discard", () => {
    throw new Error("EACCES");
  });
  assert.doesNotThrow(() => store.discardQuietly(scope));
  assert.equal(warn.mock.callCount(), 1);
});
