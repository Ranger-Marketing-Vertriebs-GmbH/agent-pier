import test from "node:test";
import assert from "node:assert/strict";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";
import {
  notifySftp,
  sftpTelegramApprovable,
} from "../../server/features/assistants/agent-sftp-notifications.js";

const transfer = (overrides = {}) => ({
  operation: "upload",
  direction: "up",
  kind: "folder",
  remotePath: "/www",
  create: ["index.html"],
  update: ["about.html"],
  delete: [],
  deleteDirs: [],
  more: { create: 0, update: 0, delete: 0 },
  moreDeleteDirs: 0,
  files: 2,
  bytes: 3 * 1024 * 1024,
  overwrites: 1,
  deletes: 0,
  ...overrides,
});
const action = (payload = {}, extra = {}) => ({
  id: "act-1",
  revision: 3,
  assistantId: "agent-1",
  conversationId: "chat-1",
  state: "awaiting_approval",
  origin: { kind: "telegram", channelId: "c1", chatId: "42", userId: "42" },
  payload: {
    action: "sftp",
    operation: "upload",
    accessId: "host-1",
    hostName: "site",
    host: "web.example",
    port: 22,
    username: "deploy",
    remotePath: "/www",
    local: { projectId: null, projectName: null, path: "site" },
    summary: transfer(),
    deletes: 0,
    allowAlways: true,
    ...payload,
  },
  ...extra,
});
function notify(a, phase = "approval", language = "en") {
  const sent = [];
  const w = {
    a: { store: { getAssistant: () => ({ name: "Ops" }) } },
    s: { assistantChannels: { outbox: { enqueue: (entry) => sent.push(entry) } } },
  };
  const m = serverCatalogs[language].assistants;
  notifySftp(w, a, phase, `action-${phase}:${a.id}`, m, a.origin);
  return sent[0];
}

test("an upload card offers Allow once, Always allow and Deny", () => {
  const entry = notify(action());
  assert.deepEqual(
    entry.actions.map((x) => [x.decision, x.label, x.revision]),
    [
      ["approve", "Allow once", 3],
      ["allow-always", "Always allow", 3],
      ["decline", "Deny", 3],
    ],
  );
  assert.equal(entry.kind, "action-approval");
  assert.equal(entry.path, "/agents/agent-1/chats/chat-1");
  for (const part of [
    "SFTP operation awaiting approval",
    "Agent: Ops",
    "deploy@web.example:22",
    "Operation: Upload",
    "Path on the server: /www",
    "Local: workspace · site",
    "New: 1 · Changed: 1 · Deleted: 0",
    "Size: 3.0 MiB",
    "Overwrites: 1",
    "index.html",
    "about.html",
  ])
    assert.ok(entry.text.includes(part), part);
});

test("a card with deletes never offers Always allow", () => {
  const entry = notify(
    action({
      operation: "delete",
      remotePath: "/old",
      local: undefined,
      summary: transfer({ create: [], update: [], delete: ["/old/a"], files: 1 }),
      deletes: 1,
      allowAlways: false,
    }),
  );
  assert.deepEqual(
    entry.actions.map((x) => x.decision),
    ["approve", "decline"],
  );
  assert.match(entry.text, /Deleted: 1/);
});

test("the deleted count includes folders the card cut", () => {
  const entry = notify(
    action({
      summary: transfer({
        delete: ["a"],
        deleteDirs: ["d1"],
        more: { create: 0, update: 0, delete: 2 },
        moreDeleteDirs: 4,
      }),
    }),
  );
  assert.match(entry.text, /Deleted: 8/);
});

test("Telegram decides only plans it lists in full", () => {
  const paths = (n) => Array.from({ length: n }, (_, i) => `f${i}.txt`);
  assert.equal(sftpTelegramApprovable(action().payload), true);
  assert.equal(
    sftpTelegramApprovable(action({ summary: transfer({ create: paths(20) }) }).payload),
    true,
  );
  for (const summary of [
    transfer({ create: paths(21) }),
    transfer({ more: { create: 1, update: 0, delete: 0 } }),
    transfer({ moreDeleteDirs: 2 }),
    transfer({ update: ["a‮b.html"] }),
  ])
    assert.equal(sftpTelegramApprovable(action({ summary }).payload), false);
  assert.equal(sftpTelegramApprovable(action({ remotePath: "/w​ww" }).payload), false);
  assert.equal(sftpTelegramApprovable({}), false);
  const long = notify(action({ summary: transfer({ create: paths(21) }) }));
  assert.deepEqual(long.actions, []);
  assert.match(long.text, /Review and allow it in AgentPier/);
  assert.equal(long.text.includes("f20.txt"), false);
  const hidden = notify(action({ remotePath: "/w​ww" }));
  assert.equal(hidden.text.includes("​"), false);
  assert.match(hidden.text, /<U\+200B>/);
});

test("German texts and the result", () => {
  const entry = notify(action(), "approval", "de");
  assert.deepEqual(
    entry.actions.map((x) => x.label),
    ["Einmal erlauben", "Immer erlauben", "Ablehnen"],
  );
  for (const part of [
    "SFTP-Vorgang wartet auf Freigabe",
    "Vorgang: Hochladen",
    "Neu: 1 · Geändert: 1 · Gelöscht: 0",
    "Überschreibungen: 1",
  ])
    assert.ok(entry.text.includes(part), part);
  const done = notify(action({}, { state: "completed" }), "result", "de");
  assert.deepEqual(done.actions, []);
  assert.match(done.text, /^SFTP-Vorgang abgeschlossen/);
  const failed = notify(
    action({}, { state: "failed", diagnostic: "SFTP_PLAN_CHANGED" }),
    "result",
  );
  assert.match(
    failed.text,
    /^SFTP operation failed; check it in AgentPier · SFTP_PLAN_CHANGED/,
  );
});
