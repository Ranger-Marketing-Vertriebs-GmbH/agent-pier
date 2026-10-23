import test from "node:test";
import assert from "node:assert/strict";
import {
  launchAccesses,
  launchSelection,
} from "../../web/features/ssh/ssh-launch-selection.js";

const accesses = [
  { id: "shell-host", type: "ssh" },
  { id: "files", type: "sftp" },
];

test("a shell launch drops chosen SFTP hosts and offers only SSH hosts", () => {
  const selected = ["shell-host", "files"];
  assert.deepEqual(launchSelection(selected, accesses, false), ["shell-host"]);
  assert.deepEqual(
    launchAccesses(accesses, false).map(({ id }) => id),
    ["shell-host"],
  );
});

test("a coding launch keeps the selection unchanged", () => {
  const selected = ["shell-host", "files"];
  assert.equal(launchSelection(selected, accesses, true), selected);
  const ssh = ["shell-host"];
  assert.equal(launchSelection(ssh, accesses, false), ssh);
  assert.equal(launchAccesses(accesses, true), accesses);
});
