import test from "node:test";
import assert from "node:assert/strict";
import { sftpNotes } from "../../server/features/assistants/agent-sftp-notes.js";
import { actionNotes } from "../../server/features/assistants/assistant-action-notifications.js";

const row = (extra = {}) => ({
  id: "j1",
  assistantId: "home",
  conversationId: "chat",
  state: "awaiting_approval",
  ...extra,
  payload: {
    action: "sftp",
    trusted: false,
    operation: "upload",
    direction: "up",
    accessId: "h1",
    hostName: "nas-01",
    host: "nas.invalid",
    port: 22,
    username: "deploy",
    hostFingerprint: "SHA256:nas",
    remotePath: "/srv/www",
    local: { projectId: "p1", projectName: "Site", path: "dist" },
    summary: { files: 124, bytes: 4096, overwrites: 2 },
    input: { action: "upload", remotePath: "/srv/www", localPath: "dist" },
    ...extra.payload,
  },
});

test("started note while executing", () => {
  const [note] = sftpNotes(
    row({
      state: "executing",
      chatNotes: { started: { at: 100 } },
      progress: { files: 124, filesDone: 12, bytes: 4096, bytesDone: 1720, current: "a" },
    }),
  );
  assert.deepEqual(note, {
    id: "sftp-run:j1",
    role: "event",
    event: "sftp-run",
    hostName: "nas-01",
    operation: "upload",
    direction: "up",
    remotePath: "/srv/www",
    toPath: null,
    localPath: "dist",
    localProject: "Site",
    state: "executing",
    progress: { files: 124, filesDone: 12, bytes: 4096, bytesDone: 1720, current: "a" },
    result: null,
    timestamp: 100,
    runId: null,
  });
});

test("settled note carries counts", () => {
  const result = {
    state: "completed",
    files: 124,
    bytes: 4096,
    created: 120,
    updated: 4,
    deleted: 0,
    overwrites: 4,
    skipped: { links: 1, special: 0, unsafe: 0 },
    durationMs: 3400,
  };
  const [note] = sftpNotes(
    row({
      state: "completed",
      memberName: "Scout",
      chatNotes: { started: { at: 100 }, result: { at: 200, state: "completed" } },
      progress: { files: 124, filesDone: 124 },
      result,
    }),
  );
  assert.equal(note.state, "completed");
  assert.equal(note.timestamp, 100, "the row keeps its place while it runs and ends");
  assert.equal(note.progress, null);
  assert.deepEqual(note.result, result);
  assert.equal(note.memberName, "Scout");
});

test("declined card leaves no note", () => {
  for (const state of ["declined", "expired", "cancelled", "awaiting_approval"])
    assert.deepEqual(sftpNotes(row({ state })), [], state);
  // An approved card whose plan changed before its job started still reports it.
  const [failed] = sftpNotes(
    row({
      state: "failed",
      chatNotes: { result: { at: 300, state: "failed" } },
      result: { state: "failed", code: "SFTP_PLAN_CHANGED" },
    }),
  );
  assert.equal(failed.timestamp, 300);
  assert.deepEqual(failed.result, { state: "failed", code: "SFTP_PLAN_CHANGED" });
});

test("a note never carries the card's input, fingerprint or anything secret", () => {
  const [note] = sftpNotes(
    row({
      state: "executing",
      chatNotes: { started: { at: 1 } },
      payload: { password: "hunter2", privateKey: "-----BEGIN" },
      result: { state: "failed", code: "X", secret: "hunter2" },
    }),
  );
  const text = JSON.stringify(note);
  for (const value of ["hunter2", "BEGIN", "deploy", "input", "secret"])
    assert.equal(text.includes(value), false, value);
});

test("chat notes dispatch SFTP rows to SFTP notes, trusted ones included", () => {
  const trusted = row({
    id: "j2",
    state: "completed",
    chatNotes: { started: { at: 5 }, result: { at: 9, state: "completed" } },
    result: { state: "completed", files: 1 },
    payload: { trusted: true },
  });
  const coding = {
    id: "c1",
    conversationId: "chat",
    state: "running",
    runId: "r1",
    chatNotes: { started: { at: 7, state: "running" } },
    payload: { action: "coding_start" },
  };
  const notes = actionNotes([trusted, coding], "chat");
  assert.deepEqual(
    notes.map((n) => [n.id, n.event]),
    [
      ["sftp-run:j2", "sftp-run"],
      ["coding-run:c1:started", "coding-run"],
    ],
  );
});
