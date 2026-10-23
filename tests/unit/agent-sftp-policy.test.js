import test from "node:test";
import assert from "node:assert/strict";
import {
  sftpKind,
  sftpPermits,
} from "../../server/features/assistants/agent-sftp-policy.js";

test("sftpKind sorts every action into read, write or delete", () => {
  const cases = [
    ["list", {}, "read"],
    ["stat", {}, "read"],
    ["download", {}, "read"],
    ["sync", { direction: "down" }, "read"],
    ["sync", { direction: "down", deleteExtra: true }, "delete"],
    ["sync", { direction: "up" }, "write"],
    ["sync", { direction: "up", deleteExtra: true }, "delete"],
    ["upload", {}, "write"],
    ["mkdir", {}, "write"],
    ["rename", {}, "write"],
    ["delete", {}, "delete"],
    ["delete", { recursive: true }, "delete"],
    // A dry run only plans and changes nothing.
    ["upload", { dryRun: true }, "read"],
    ["sync", { direction: "up", deleteExtra: true, dryRun: true }, "read"],
  ];
  for (const [action, input, kind] of cases)
    assert.equal(sftpKind(action, input), kind, `${action} ${JSON.stringify(input)}`);
  assert.throws(() => sftpKind("execute", {}), TypeError);
});

test("sftpPermits covers every mode, class and kind", () => {
  const expected = {
    owner: {
      approval: { read: "run", write: "card", delete: "card" },
      trusted: { read: "run", write: "run", delete: "card" },
      routines: { read: "run", write: "run", delete: "card" },
    },
    delegated: {
      approval: { read: "run", write: "card", delete: "card" },
      trusted: { read: "run", write: "run", delete: "card" },
      routines: { read: "run", write: "run", delete: "card" },
    },
    routine: {
      approval: { read: "refuse", write: "refuse", delete: "refuse" },
      trusted: { read: "refuse", write: "refuse", delete: "refuse" },
      routines: { read: "run", write: "run", delete: "refuse" },
    },
    refused: {
      approval: { read: "refuse", write: "refuse", delete: "refuse" },
      trusted: { read: "refuse", write: "refuse", delete: "refuse" },
      routines: { read: "refuse", write: "refuse", delete: "refuse" },
    },
  };
  for (const [cls, modes] of Object.entries(expected))
    for (const [mode, kinds] of Object.entries(modes))
      for (const [kind, verdict] of Object.entries(kinds))
        assert.equal(sftpPermits(mode, cls, kind), verdict, `${cls} ${mode} ${kind}`);
  assert.equal(sftpPermits("always", "owner", "read"), "refuse");
  assert.equal(sftpPermits("trusted", "stranger", "read"), "refuse");
  assert.equal(sftpPermits("trusted", "owner", "erase"), "refuse");
});
