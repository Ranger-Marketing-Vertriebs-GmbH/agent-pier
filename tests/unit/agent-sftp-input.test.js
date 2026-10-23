import test from "node:test";
import assert from "node:assert/strict";
import {
  sftpActions,
  sftpInput,
} from "../../server/features/assistants/agent-sftp-input.js";

const accessId = "33333333-3333-4333-8333-333333333333";
const invalid = { status: 400, key: "invalid" };

test("sftpActions names the file actions of agentpier_ssh", () => {
  assert.deepEqual(
    [...sftpActions],
    [
      "list",
      "stat",
      "download",
      "upload",
      "sync",
      "mkdir",
      "rename",
      "delete",
      "job",
      "cancel",
    ],
  );
});

test("each action is normalized with its defaults", () => {
  assert.deepEqual(sftpInput({ action: "list", accessId }), {
    action: "list",
    accessId,
    remotePath: ".",
  });
  assert.deepEqual(
    sftpInput({ action: "upload", accessId, localPath: "site", remotePath: "/www" }),
    {
      action: "upload",
      accessId,
      localPath: "site",
      remotePath: "/www",
      exclude: [],
      defaultExcludes: true,
      dryRun: false,
    },
  );
  assert.deepEqual(
    sftpInput({
      action: "sync",
      accessId,
      direction: "up",
      remotePath: "/www",
      projectId: "p1",
      deleteExtra: true,
      checksum: true,
      exclude: ["*.map"],
      defaultExcludes: false,
    }),
    {
      action: "sync",
      accessId,
      direction: "up",
      remotePath: "/www",
      projectId: "p1",
      deleteExtra: true,
      checksum: true,
      exclude: ["*.map"],
      defaultExcludes: false,
      dryRun: false,
    },
  );
  assert.deepEqual(sftpInput({ action: "mkdir", accessId, remotePath: "a/b" }), {
    action: "mkdir",
    accessId,
    remotePath: "a/b",
    parents: false,
  });
  assert.deepEqual(sftpInput({ action: "delete", accessId, remotePath: "old" }), {
    action: "delete",
    accessId,
    remotePath: "old",
    recursive: false,
  });
  assert.deepEqual(sftpInput({ action: "job", jobId: "j1" }), {
    action: "job",
    jobId: "j1",
  });
});

test("missing required fields are refused", () => {
  assert.throws(() => sftpInput({ action: "stat", accessId }), invalid);
  assert.throws(() => sftpInput({ action: "download", accessId }), invalid);
  assert.throws(
    () => sftpInput({ action: "upload", accessId, remotePath: "/" }),
    invalid,
  );
  assert.throws(() => sftpInput({ action: "sync", accessId, remotePath: "/" }), invalid);
  assert.throws(
    () => sftpInput({ action: "rename", accessId, remotePath: "a" }),
    invalid,
  );
  assert.throws(() => sftpInput({ action: "list" }), invalid);
  assert.throws(() => sftpInput({ action: "cancel" }), invalid);
});

test("unknown keys and keys of other actions are refused", () => {
  assert.throws(() => sftpInput({ action: "list", accessId, command: "ls" }), invalid);
  assert.throws(
    () => sftpInput({ action: "stat", accessId, remotePath: "a", recursive: true }),
    invalid,
  );
  assert.throws(
    () =>
      sftpInput({
        action: "upload",
        accessId,
        localPath: "a",
        remotePath: "b",
        deleteExtra: true,
      }),
    invalid,
  );
  assert.throws(() => sftpInput({ action: "job", jobId: "j", accessId }), invalid);
  assert.throws(() => sftpInput({ action: "erase", accessId }), invalid);
  assert.throws(() => sftpInput(null), invalid);
});

test("values are checked against the limits", () => {
  const exclude = Array.from({ length: 51 }, (_, i) => `p${i}`);
  const base = { action: "download", accessId, remotePath: "a" };
  assert.throws(() => sftpInput({ ...base, exclude }), invalid);
  assert.ok(sftpInput({ ...base, exclude: exclude.slice(1) }));
  assert.throws(() => sftpInput({ ...base, exclude: ["x".repeat(201)] }), invalid);
  assert.throws(() => sftpInput({ ...base, exclude: [""] }), invalid);
  assert.throws(() => sftpInput({ ...base, remotePath: "x".repeat(4097) }), invalid);
  assert.throws(() => sftpInput({ ...base, remotePath: "" }), invalid);
  assert.throws(() => sftpInput({ ...base, localPath: "a\0b" }), invalid);
  assert.throws(() => sftpInput({ ...base, dryRun: "yes" }), invalid);
  assert.throws(() => sftpInput({ ...base, accessId: "x".repeat(101) }), invalid);
  assert.throws(
    () => sftpInput({ action: "sync", accessId, remotePath: "a", direction: "sideways" }),
    invalid,
  );
});

test("a sync down that deletes extra local files must name its local folder", () => {
  const sync = { action: "sync", accessId, remotePath: "/www", direction: "down" };
  assert.throws(() => sftpInput({ ...sync, deleteExtra: true }), invalid);
  assert.throws(() => sftpInput({ ...sync, deleteExtra: true, dryRun: true }), invalid);
  assert.equal(
    sftpInput({ ...sync, deleteExtra: true, localPath: "backup" }).deleteExtra,
    true,
  );
});
