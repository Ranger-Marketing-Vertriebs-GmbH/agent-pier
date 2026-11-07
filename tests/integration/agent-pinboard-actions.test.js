import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pinboardFixture } from "../helpers/agent-pinboard-fixture.js";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import {
  AgentPinboard,
  pinboardNote,
} from "../../server/features/assistants/agent-pinboard.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { toolError, toolReason } from "../../server/features/assistants/tool-errors.js";

const pinboardAudits = (f) => f.audits.filter((e) => e.details?.kind === "pinboard");
const key = (expected) => (error) => error?.key === expected;
const ownerOnly = key("pinboardOwnerOnly");

// Every file below the folder, relative.
const filesIn = (dir) =>
  fs.readdirSync(dir, { recursive: true }).filter((name) => {
    return fs.statSync(path.join(dir, name)).isFile();
  });

// As an agent rewrites a file atomically: a temp file renamed over it.
function renameOver(target, body) {
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, body);
  fs.renameSync(temp, target);
}

async function episodes(f) {
  const created = await f.call({ action: "create_list", title: "Episodes" });
  return created.list.id;
}

const entryOf = async (f, name) =>
  (await f.pinboard.view(f.id)).lists
    .flatMap((list) => list.entries)
    .find((entry) => entry.name === name);

test("create, pin and list: entries are links with versions", async (t) => {
  const f = await pinboardFixture(t);
  f.file("out/ep6.md", "# Episode 6\n");
  const before = filesIn(f.workspace).length;
  const attachments = () =>
    f.store.db.prepare("SELECT COUNT(*) AS n FROM agent_attachments").get().n;
  const rows = attachments();
  const created = await f.call({
    action: "create_list",
    title: "Episodes",
    description: "Season 1",
  });
  assert.equal(created.status, "created");
  assert.equal(created.list.title, "Episodes");
  assert.equal(created.note, pinboardNote);
  const pinned = await f.call({
    action: "pin",
    listId: created.list.id,
    path: "out/ep6.md",
    note: "draft",
  });
  assert.equal(pinned.status, "pinned");
  assert.deepEqual(pinned.list, { id: created.list.id, title: "Episodes", entries: 1 });
  assert.equal(pinned.entry.name, "ep6.md");
  assert.equal(pinned.entry.version, 1);
  assert.equal(pinned.note, pinboardNote);
  const listed = await f.call({ action: "list" });
  assert.deepEqual(listed, {
    status: "ok",
    lists: [
      {
        id: created.list.id,
        title: "Episodes",
        description: "Season 1",
        archived: false,
        entries: [{ id: pinned.entry.id, name: "ep6.md", note: "draft", version: 1 }],
      },
    ],
  });
  // An absolute spelling inside the workspace names the same entry.
  const again = await f.call({
    action: "pin",
    listId: created.list.id,
    path: path.join(f.workspace, "out/ep6.md"),
    note: "draft",
  });
  assert.equal(again.status, "replaced");
  assert.equal(again.entry.version, 2);
  // A link: nothing copied, the stored path is the one resolved at pin time.
  assert.equal(filesIn(f.workspace).length, before);
  assert.equal(attachments(), rows);
  const [stored] = f.pinboard.store.getList(f.id, created.list.id).entries;
  assert.equal(stored.root, "workspace");
  assert.equal(stored.path, "out/ep6.md");
  assert.equal(stored.identity.kind, "text");
  // Every write is audited; the list is not.
  assert.deepEqual(
    pinboardAudits(f).map((e) => auditEvent(e).details.pinboard),
    ["create_list", "pin", "pin"],
  );
});

test("pinning the same name again replaces the entry and bumps its version", async (t) => {
  const f = await pinboardFixture(t);
  f.file("out/ep6.md", "one");
  f.file("out/ep6-v2.md", "two");
  const listId = await episodes(f);
  await f.call({ action: "pin", listId, path: "out/ep6.md", name: "Episode 6" });
  const again = await f.call({
    action: "pin",
    listId,
    path: "out/ep6-v2.md",
    name: "Episode 6",
  });
  assert.equal(again.status, "replaced");
  assert.equal(again.entry.version, 2);
  assert.equal(again.list.entries, 1);
});

test("pinning into an archived list reopens it", async (t) => {
  const f = await pinboardFixture(t);
  f.file("out/ep6.md");
  const listId = await episodes(f);
  assert.equal((await f.call({ action: "archive_list", listId })).status, "archived");
  assert.equal((await f.call({ action: "list" })).lists[0].archived, true);
  assert.equal(
    (await f.call({ action: "pin", listId, path: "out/ep6.md" })).status,
    "pinned",
  );
  assert.equal(f.pinboard.store.getList(f.id, listId).archivedAt, null);
  assert.equal((await f.call({ action: "archive_list", listId })).status, "archived");
  assert.equal((await f.call({ action: "reopen_list", listId })).status, "reopened");
});

test("unpin and delete_list leave the files", async (t) => {
  const f = await pinboardFixture(t);
  const file = f.file("out/ep6.md");
  f.file("out/ep7.md");
  const listId = await episodes(f);
  const pinned = await f.call({ action: "pin", listId, path: "out/ep6.md" });
  await f.call({ action: "pin", listId, path: "out/ep7.md" });
  const unpinned = await f.call({ action: "unpin", listId, name: "ep6.md" });
  assert.deepEqual(unpinned, {
    status: "unpinned",
    entry: { id: pinned.entry.id, name: "ep6.md" },
  });
  await assert.rejects(
    f.call({ action: "unpin", listId, entryId: pinned.entry.id }),
    key("pinboardEntryNotFound"),
  );
  assert.equal((await f.call({ action: "delete_list", listId })).status, "deleted");
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(path.join(f.workspace, "out/ep7.md")));
  await assert.rejects(
    f.call({ action: "unpin", listId, name: "x" }),
    key("pinboardListNotFound"),
  );
});

test("update_list and reorder change the list", async (t) => {
  const f = await pinboardFixture(t);
  f.file("a.md");
  f.file("b.md");
  const listId = await episodes(f);
  const a = await f.call({ action: "pin", listId, path: "a.md" });
  const b = await f.call({ action: "pin", listId, path: "b.md" });
  const updated = await f.call({ action: "update_list", listId, title: "Season 1" });
  assert.equal(updated.status, "updated");
  assert.equal(updated.list.title, "Season 1");
  const reordered = await f.call({
    action: "reorder",
    listId,
    entryIds: [b.entry.id, a.entry.id],
  });
  assert.deepEqual(reordered, { status: "reordered" });
  const [list] = (await f.call({ action: "list" })).lists;
  assert.deepEqual(
    list.entries.map((entry) => entry.name),
    ["b.md", "a.md"],
  );
});

test("input outside the tool schema is refused", async (t) => {
  const f = await pinboardFixture(t);
  for (const input of [
    null,
    {},
    { action: "drop" },
    { action: "list", extra: 1 },
    { action: "create_list" },
    { action: "create_list", title: " " },
    { action: "create_list", title: "x".repeat(121) },
    { action: "pin", listId: "l" },
    { action: "unpin", listId: "l" },
    { action: "reorder", listId: "l", entryIds: "a" },
    { action: "reorder", listId: "l", entryIds: Array(101).fill("a") },
    { action: "pin", listId: "l", path: "a.md", note: "x".repeat(201) },
  ])
    await assert.rejects(f.call(input), key("invalid"), JSON.stringify(input));
});

test("the pinboard refusals carry their own tool codes", () => {
  for (const [name, code] of [
    ["pinboardListNotFound", "PINBOARD_LIST_NOT_FOUND"],
    ["pinboardEntryNotFound", "PINBOARD_ENTRY_NOT_FOUND"],
    ["pinboardListLimit", "PINBOARD_LIST_LIMIT"],
    ["pinboardEntryLimit", "PINBOARD_ENTRY_LIMIT"],
    ["pinboardOwnerOnly", "PINBOARD_OWNER_ONLY"],
  ]) {
    const error = toolError(assistantProblem(name, 404));
    assert.equal(error.code, code);
    assert.equal(error.reason, toolReason(code));
    assert.notEqual(error.reason, toolReason("UNAVAILABLE"));
  }
});

test("a restricted user's turn is refused every action", async (t) => {
  const f = await pinboardFixture(t, {
    userAccess: {
      mode: "shared",
      members: [{ userId: "anna", level: "chat" }],
      released: [],
    },
  });
  f.file("out/ep6.md");
  // The fixture's chat as Anna's own.
  f.store.updateConversation(f.channel.conversationId, { userId: "anna" });
  await f.turn({ kind: "user", userId: "anna" });
  for (const input of [
    { action: "list" },
    { action: "create_list", title: "Mine" },
    { action: "pin", listId: "x", path: "out/ep6.md" },
  ])
    await assert.rejects(f.call(input), ownerOnly, input.action);
  assert.deepEqual(f.pinboard.store.lists(f.id), []);
});

test("a user's own agent has no pinboard", async (t) => {
  const f = await pinboardFixture(t, {
    userAccess: {
      mode: "own",
      members: [{ userId: "anna", level: "chat" }],
      released: [],
    },
  });
  await f.turn({ kind: "owner" });
  await assert.rejects(f.call({ action: "list" }), ownerOnly);
  await assert.rejects(f.call({ action: "create_list", title: "Mine" }), ownerOnly);
});

test("the view marks NEW until the owner has seen the current file", async (t) => {
  const f = await pinboardFixture(t);
  const file = f.file("out/ep6.md", "# Episode 6\n");
  const listId = await episodes(f);
  const { entry } = await f.call({ action: "pin", listId, path: "out/ep6.md" });
  let view = await f.pinboard.view(f.id);
  assert.equal(view.fresh, 1);
  const [list] = view.lists;
  assert.equal(list.title, "Episodes");
  assert.deepEqual(list.origin, {
    conversationId: f.channel.conversationId,
    title: f.store.getConversation(f.channel.conversationId).title,
  });
  assert.equal(list.archived, false);
  const [shown] = list.entries;
  assert.equal(shown.state, "ok");
  assert.equal(shown.fresh, true);
  assert.equal(shown.kind, "text");
  assert.equal(shown.type, "text/markdown");
  assert.equal(shown.size, Buffer.byteLength("# Episode 6\n"));
  f.changes.length = 0;
  await f.pinboard.seen(f.id, entry.id);
  assert.deepEqual(f.changes, [f.id]);
  view = await f.pinboard.view(f.id);
  assert.equal(view.fresh, 0);
  assert.equal(view.lists[0].entries[0].fresh, false);
  renameOver(file, "# Episode 6, take 2\n");
  view = await f.pinboard.view(f.id);
  assert.equal(view.fresh, 1);
  const [after] = view.lists[0].entries;
  assert.equal(after.version, 2);
  assert.equal(after.state, "ok");
  assert.equal(after.fresh, true);
  // A read changes nothing the owner is told about.
  assert.deepEqual(f.changes, [f.id]);
  const opened = await f.pinboard.open(f.id, entry.id);
  try {
    assert.equal(opened.name, "ep6.md");
    assert.equal(opened.kind, "text");
    assert.equal(opened.inline, false);
    assert.equal(opened.size, Buffer.byteLength("# Episode 6, take 2\n"));
    const { buffer } = await opened.handle.read(
      Buffer.alloc(opened.size),
      0,
      opened.size,
      0,
    );
    assert.equal(buffer.toString(), "# Episode 6, take 2\n");
  } finally {
    await opened.handle.close();
  }
});

test("a deleted file reads unavailable and does not count as NEW", async (t) => {
  const f = await pinboardFixture(t);
  const file = f.file("out/ep6.md");
  const listId = await episodes(f);
  const { entry } = await f.call({ action: "pin", listId, path: "out/ep6.md" });
  fs.rmSync(file);
  const view = await f.pinboard.view(f.id);
  assert.equal(view.fresh, 0);
  assert.equal(view.lists[0].entries[0].state, "unavailable");
  assert.equal(view.lists[0].entries[0].fresh, false);
  await assert.rejects(f.pinboard.seen(f.id, entry.id), key("pinboardUnavailable"));
  await assert.rejects(f.pinboard.open(f.id, entry.id), key("pinboardUnavailable"));
  await assert.rejects(f.pinboard.open(f.id, "none"), key("pinboardEntryNotFound"));
});

test("one turn's writes record one change per list", async (t) => {
  const f = await pinboardFixture(t);
  f.file("a.md");
  f.file("b.md");
  const a = await episodes(f);
  const b = (await f.call({ action: "create_list", title: "Notes" })).list.id;
  f.changes.length = 0;
  await f.call({ action: "pin", listId: a, path: "a.md" });
  await f.call({ action: "pin", listId: a, path: "b.md" });
  await f.call({ action: "pin", listId: b, path: "a.md" });
  const changes = f.pinboard.store.changesFor(f.channel.conversationId);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((change) => change.assistantId === f.id));
  const first = changes.find((change) => change.listId === a);
  assert.equal(first.added, 2);
  assert.deepEqual(first.names, ["a.md", "b.md"]);
  assert.deepEqual(f.changes, [f.id, f.id, f.id]);
  await f.call({ action: "unpin", listId: b, name: "a.md" });
  assert.equal(
    f.pinboard.store.changesFor(f.channel.conversationId).find((c) => c.listId === b)
      .removed,
    1,
  );
});

test("a member's pins stay on the member's board", async (t) => {
  const f = teamFixture(t);
  const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-team-"));
  t.after(() => fs.rmSync(workspaces, { recursive: true, force: true }));
  f.assistants.attachments.config.workspaces = workspaces;
  const pinboard = new AgentPinboard({ assistants: f.assistants });
  const { team, parent: lead } = await f.proposal({ count: 1 });
  await f.service.reconcile();
  const [member] = f.service.store.members(team.id);
  fs.mkdirSync(path.join(workspaces, member.id), { recursive: true });
  fs.writeFileSync(path.join(workspaces, member.id, "review.md"), "# Review\n");
  const invocation = { attemptId: member.attemptId, toolCallId: "c", assertCurrent() {} };
  const { list } = await pinboard.invoke(invocation, {
    action: "create_list",
    title: "Review",
  });
  const pinned = await pinboard.invoke(invocation, {
    action: "pin",
    listId: list.id,
    path: "review.md",
  });
  assert.equal(pinned.status, "pinned");
  assert.equal(pinboard.store.lists(member.id).length, 1);
  assert.deepEqual(pinboard.store.lists(lead.id), []);
});

test("a hook run pins only from folders it could share from", async (t) => {
  const f = await pinboardFixture(t);
  const folder = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-hook-")),
  );
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "plan.md"), "# Plan\n");
  const project = await f.memory.register(folder);
  f.workflows.access.save(
    f.id,
    { ...f.policy, projectIds: [project.id], projectFiles: { [project.id]: "read" } },
    f.workflows.access.get(f.id).revision,
  );
  const listId = await episodes(f);
  const conversation = f.store.getConversation(f.channel.conversationId);
  // A hook whose own rights name no folder.
  f.assistants.routines = {
    hooks: {
      runOrigin: () => ({
        event: { id: "event-1" },
        hook: { id: "h1", name: "Mail" },
        effective: { folders: {}, coding: false },
        conversation,
      }),
    },
  };
  const hook = {
    attemptId: null,
    hook: { conversation, event: { id: "event-1" } },
    sessionKey: "hook-session",
    assertCurrent() {},
  };
  const input = { action: "pin", listId, projectId: project.id, path: "plan.md" };
  await assert.rejects(f.pinboard.invoke(hook, input), key("projectFolderNotGranted"));
  // The hook may pin from the workspace; its card goes to the list's origin chat.
  f.file("hook.md");
  const fromHook = await f.pinboard.invoke(hook, {
    action: "pin",
    listId,
    path: "hook.md",
  });
  assert.equal(fromHook.status, "pinned");
  assert.ok(
    f.pinboard.store
      .changesFor(conversation.id)
      .some((change) => change.requestId === "hook:event-1"),
  );
  // Stored as resolved at pin time, so the owner's reads find the same file.
  const pinned = await f.call({ ...input, path: "./plan.md" });
  assert.equal(pinned.status, "pinned");
  const stored = f.pinboard.store
    .getList(f.id, listId)
    .entries.find((entry) => entry.name === "plan.md");
  assert.equal(stored.root, `project:${project.id}`);
  assert.equal(stored.path, "plan.md");
  assert.equal((await entryOf(f, "plan.md")).state, "ok");
  // As the audit log stores it (audit-schema.js).
  assert.deepEqual(auditEvent(pinboardAudits(f).at(-1)), {
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: f.id,
    projectId: project.id,
    source: "system",
    outcome: "success",
    details: { kind: "pinboard", pinboard: "pin" },
  });
});

test("a pin of a chat's upload is unavailable once that chat is deleted, without an error", async (t) => {
  const f = await pinboardFixture(t);
  f.file("attachments/photo.md", "# Upload\n");
  f.file("out/ep6.md");
  const listId = await episodes(f);
  await f.call({ action: "pin", listId, path: "attachments/photo.md" });
  await f.call({ action: "pin", listId, path: "out/ep6.md" });
  assert.equal((await entryOf(f, "photo.md")).state, "ok");
  f.store.updateConversation(f.channel.conversationId, {
    deletedAt: new Date().toISOString(),
  });
  const view = await f.pinboard.view(f.id);
  assert.equal(view.lists[0].origin, null);
  const states = Object.fromEntries(view.lists[0].entries.map((e) => [e.name, e.state]));
  assert.deepEqual(states, { "photo.md": "unavailable", "ep6.md": "ok" });
});

test("the view does not re-hash or re-sniff an unchanged file", async (t) => {
  const f = await pinboardFixture(t);
  const file = f.file("out/ep6.md", "# Episode 6\n");
  f.file("old.md");
  const listId = await episodes(f);
  await f.call({ action: "pin", listId, path: "out/ep6.md" });
  const old = (await f.call({ action: "create_list", title: "Old" })).list.id;
  await f.call({ action: "pin", listId: old, path: "old.md" });
  await f.call({ action: "archive_list", listId: old });
  const files = f.pinboard.viewer.files;
  const calls = { pinIdentity: 0, pinType: 0, openPinned: [] };
  for (const name of ["pinIdentity", "pinType"]) {
    const original = files[name];
    files[name] = (...args) => (calls[name]++, original(...args));
  }
  const open = files.openPinned;
  files.openPinned = (assistants, agent, at, options) => (
    calls.openPinned.push(at.path),
    open(assistants, agent, at, options)
  );
  await f.pinboard.view(f.id);
  await f.pinboard.view(f.id);
  assert.equal(calls.pinIdentity, 0);
  assert.equal(calls.pinType, 0);
  // Archived lists' files are not opened.
  assert.deepEqual(calls.openPinned, ["out/ep6.md", "out/ep6.md"]);
  const archived = (await f.pinboard.view(f.id)).lists.find((l) => l.id === old);
  assert.equal(archived.archived, true);
  assert.equal(archived.entries[0].state, "ok");
  assert.equal(archived.entries[0].fresh, false);
  // A touch of a small file refreshes the identity, without a new version.
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(file, later, later);
  const touched = await entryOf(f, "ep6.md");
  assert.equal(touched.version, 1);
  assert.equal(calls.pinIdentity, 1);
  assert.equal(calls.pinType, 1);
  await f.pinboard.view(f.id);
  assert.equal(calls.pinIdentity, 1);
});

test("concurrent views bump the version once", async (t) => {
  const f = await pinboardFixture(t);
  const file = f.file("out/ep6.md", "one");
  const listId = await episodes(f);
  await f.call({ action: "pin", listId, path: "out/ep6.md" });
  renameOver(file, "two!");
  const views = await Promise.all([f.pinboard.view(f.id), f.pinboard.view(f.id)]);
  for (const view of views) assert.equal(view.lists[0].entries[0].version, 2);
  assert.equal((await entryOf(f, "ep6.md")).version, 2);
});

test("an in-place edit moves the list to the top", async (t) => {
  const f = await pinboardFixture(t);
  const file = f.file("a.md", "a");
  f.file("b.md", "b");
  const a = await episodes(f);
  await f.call({ action: "pin", listId: a, path: "a.md" });
  await delay(5);
  const b = (await f.call({ action: "create_list", title: "Notes" })).list.id;
  await f.call({ action: "pin", listId: b, path: "b.md" });
  assert.deepEqual(
    (await f.pinboard.view(f.id)).lists.map((list) => list.id),
    [b, a],
  );
  await delay(5);
  fs.writeFileSync(file, "a, edited");
  const view = await f.pinboard.view(f.id);
  assert.deepEqual(
    view.lists.map((list) => list.id),
    [a, b],
  );
  assert.ok(view.lists[0].updatedAt > view.lists[1].updatedAt);
});

test("list-level actions record no card", async (t) => {
  const f = await pinboardFixture(t);
  const listId = await episodes(f);
  await f.call({ action: "update_list", listId, description: "Season 1" });
  await f.call({ action: "archive_list", listId });
  assert.deepEqual(f.pinboard.store.changesFor(f.channel.conversationId), []);
  assert.deepEqual(f.changes, [f.id, f.id, f.id]);
});
