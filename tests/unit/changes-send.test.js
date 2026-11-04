import test from "node:test";
import assert from "node:assert/strict";
import { parseGitDiff } from "../../server/features/changes/diff-parse.js";
import { anchorAt } from "../../server/features/changes/review-anchor.js";
import { ChatDraft, deliveryScope } from "../../web/features/chat/chat-draft.js";
import { registerComposer } from "../../web/features/chat/composer-registry.js";
import { sendBatch, sessionBatch } from "../../web/features/sessions/changes-send.js";

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
const lock = (name, operation) => Promise.resolve().then(operation);

const diffOf = (path, start, lines) =>
  parseGitDiff(
    [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -${start},3 +${start},3 @@`,
      ...lines,
    ].join("\n"),
  );
const treeFiles = diffOf("server/a.js", 40, [
  " const user = load();",
  "-if (pw === user.pw) return ok();",
  "+if (await verify(pw, user.hash)) return ok();",
  " return fail();",
]);
const dirFiles = diffOf("server/b.js", 1, [
  " import x from 'x';",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
]);
const tree = ".worktrees/feat/x";
const comment = (id, workspace, file, files, index, extra = {}) => ({
  id,
  workspace,
  file,
  anchor: anchorAt(files[0].rows, index),
  body: `note ${id}`,
  status: "open",
  sentIn: null,
  ...extra,
});
const inWorktree = comment("w1", tree, "server/a.js", treeFiles, 3);
const inSessionDir = comment("d1", "", "server/b.js", dirFiles, 4);
const resolved = comment("r1", "", "server/b.js", dirFiles, 4, { status: "resolved" });

let counter = 0;
const sessionOf = (extra = {}) => ({
  id: `s${++counter}`,
  accountId: "a",
  tool: "claude",
  createdAt: "x",
  ...extra,
});

function harness(t, session, { register = true } = {}) {
  const draft = new ChatDraft(storage(), deliveryScope(session), lock);
  if (register) t.after(registerComposer(deliveryScope(session), draft));
  const marked = [];
  const reads = [];
  const copied = [];
  return {
    draft,
    marked,
    reads,
    copied,
    readDiff: async (workspace) => {
      reads.push(workspace);
      return { "": dirFiles, [tree]: treeFiles }[workspace] ?? null;
    },
    markSent: async (ids) => {
      marked.push(ids);
      return { batch: marked.length };
    },
    clipboard: async (text) => {
      copied.push(text);
      return true;
    },
  };
}
const pick = (result) => ({ outcome: result.outcome, reason: result.reason });

test("sessionBatch formats the open comments and lists their ids", () => {
  const diffs = new Map([
    ["", dirFiles],
    [tree, treeFiles],
  ]);
  const { text, ids } = sessionBatch([inWorktree, inSessionDir, resolved], diffs);
  assert.deepEqual(ids, ["d1", "w1"]);
  assert.match(text, /^Review notes \(2\):/);
  assert.equal(sessionBatch([resolved], diffs).text, "");
});

test("the batch spans workspaces and marks what was sent", async (t) => {
  const session = sessionOf();
  const h = harness(t, session);
  await h.draft.change({ text: "please also" });
  const result = await sendBatch({
    session,
    comments: [inWorktree, inSessionDir, resolved],
    readDiff: h.readDiff,
    markSent: h.markSent,
    clipboard: h.clipboard,
  });
  assert.equal(result.outcome, "appended");
  assert.equal(result.batch, 1);
  assert.match(
    h.draft.getSnapshot().text,
    /^please also\nReview notes \(2\):[\s\S]*1\. server\/b\.js:3[\s\S]*2\. \.worktrees\/feat\/x\/server\/a\.js:41/,
  );
  assert.deepEqual(h.marked, [["d1", "w1"]]);
  assert.deepEqual(h.reads.sort(), ["", tree].sort());
  assert.deepEqual(h.copied, []);
});

test("a loaded diff is used as is and only missing ones are read", async (t) => {
  const session = sessionOf();
  const h = harness(t, session);
  const readDiff = (workspace) => (workspace === "" ? dirFiles : h.readDiff(workspace));
  const result = await sendBatch({
    session,
    comments: [inSessionDir],
    readDiff,
    markSent: h.markSent,
  });
  assert.equal(result.outcome, "appended");
  assert.deepEqual(h.reads, []);
});

test("no open comments send nothing", async (t) => {
  const session = sessionOf();
  const h = harness(t, session);
  const result = await sendBatch({ session, comments: [resolved], ...h });
  assert.equal(result.outcome, "empty");
  assert.deepEqual(h.marked, []);
  assert.equal(h.draft.getSnapshot().text, "");
});

test("shell sessions and locked drafts copy; a refused clipboard shows the text", async (t) => {
  const shell = sessionOf({ tool: "shell" });
  const s = harness(t, shell);
  const copied = await sendBatch({ session: shell, comments: [inSessionDir], ...s });
  assert.deepEqual(pick(copied), { outcome: "copied", reason: "no-chat" });
  assert.equal(copied.batch, 1);
  assert.match(s.copied[0], /^Review notes \(1\):/);
  // a shell session's draft (none in practice) is never touched
  assert.equal(s.draft.getSnapshot().text, "");

  const locked = sessionOf();
  const l = harness(t, locked);
  await l.draft.change({ text: "hello" });
  await l.draft.enqueue("m1", [], {});
  const shown = await sendBatch({
    session: locked,
    comments: [inSessionDir],
    ...l,
    clipboard: async () => false,
  });
  assert.deepEqual(pick(shown), { outcome: "shown", reason: "locked" });
  assert.match(shown.text, /^Review notes \(1\):/);
  assert.deepEqual(l.marked, []);
  assert.equal(s.marked.length, 1); // only the copied one
});

test("a login session and a session without a mounted composer copy", async (t) => {
  const login = sessionOf({ purpose: "login" });
  const a = harness(t, login);
  assert.deepEqual(
    pick(await sendBatch({ session: login, comments: [inSessionDir], ...a })),
    {
      outcome: "copied",
      reason: "no-chat",
    },
  );
  assert.equal(a.draft.getSnapshot().text, "");
  const unmounted = sessionOf();
  const b = harness(t, unmounted, { register: false });
  assert.deepEqual(
    pick(await sendBatch({ session: unmounted, comments: [inSessionDir], ...b })),
    { outcome: "copied", reason: "no-chat" },
  );
});

test("a locked draft copies and marks the batch", async (t) => {
  const session = sessionOf();
  const h = harness(t, session);
  await h.draft.change({ text: "hello" });
  await h.draft.enqueue("m1", [], {});
  const result = await sendBatch({ session, comments: [inSessionDir], ...h });
  assert.deepEqual(pick(result), { outcome: "copied", reason: "locked" });
  assert.deepEqual(h.marked, [["d1"]]);
});

test("too-long and an unconfirmed edit never mark comments", async (t) => {
  const session = sessionOf();
  const h = harness(t, session);
  await h.draft.change({ text: "x".repeat(31990) });
  const long = await sendBatch({ session, comments: [inSessionDir], ...h });
  assert.equal(long.outcome, "too-long");
  assert.equal(h.draft.getSnapshot().text.length, 31990);
  assert.deepEqual(h.copied, []);
  assert.deepEqual(h.marked, []);

  const other = sessionOf();
  const o = harness(t, other);
  o.draft.change = async () => {};
  const refused = await sendBatch({
    session: other,
    comments: [inSessionDir],
    ...o,
    clipboard: async () => false,
  });
  assert.deepEqual(pick(refused), { outcome: "shown", reason: "locked" });
  assert.deepEqual(o.marked, []);
});

test("a failed mark still reports where the batch went", async (t) => {
  const session = sessionOf();
  const h = harness(t, session);
  const result = await sendBatch({
    session,
    comments: [inSessionDir],
    ...h,
    markSent: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(result.outcome, "appended");
  assert.equal(result.batch, undefined);
  assert.equal(result.error, "offline");
});
