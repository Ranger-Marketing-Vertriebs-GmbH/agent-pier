import test from "node:test";
import assert from "node:assert/strict";
import { sshGrantEntries } from "../../web/features/ssh/ssh-grant-entries.js";
import { sshCopy as copy } from "../../web/lib/i18n/en/ssh.js";
import { sshProjectCopy as projectCopy } from "../../web/lib/i18n/en/ssh-projects.js";

// SSH accesses as grant picker entries: the connection as `sub`, SFTP as a badge, an
// access the project grants locked with its note, and the explicit assignment of an
// inherited access removable through the row's action.
const access = (id, fields = {}) => ({
  id,
  name: id,
  host: `${id}.example.test`,
  port: 22,
  username: "deploy",
  ...fields,
});
const accesses = [
  access("plain"),
  access("files", { type: "sftp", port: 2222 }),
  access("inherited"),
  access("both"),
];

test("SSH accesses become grant entries with connection, badge, lock and notes", () => {
  const removed = [];
  const entries = sshGrantEntries(accesses, {
    selected: ["both"],
    inherited: ["inherited", "both"],
    onRemoveExplicit: (id) => removed.push(id),
    copy,
    projectCopy,
  });
  assert.deepEqual(
    entries.map((entry) => entry.sub),
    [
      "deploy@plain.example.test:22",
      "deploy@files.example.test:2222",
      "deploy@inherited.example.test:22",
      "deploy@both.example.test:22",
    ],
  );
  assert.deepEqual(
    entries.map((entry) => entry.badge),
    [undefined, "SFTP", undefined, undefined],
  );
  assert.deepEqual(
    entries.map((entry) => Boolean(entry.locked)),
    [false, false, true, true],
  );
  assert.deepEqual(
    entries.map((entry) => entry.notes),
    [[], [], ["Project managed"], ["Project managed", "Explicit session assignment"]],
  );
  assert.deepEqual(
    entries.map((entry) => Boolean(entry.action)),
    [false, false, false, true],
  );
  assert.equal(entries[3].action.label, "Remove explicit assignment");
  entries[3].action.onClick();
  assert.deepEqual(removed, ["both"]);
  assert.deepEqual(
    entries.map((entry) => [entry.id, entry.name]),
    accesses.map((item) => [item.id, item.name]),
  );
});

test("a selected access is noted as explicit; without a handler nothing offers removal", () => {
  const entries = sshGrantEntries([access("chosen"), access("both")], {
    selected: ["chosen", "both"],
    inherited: ["both"],
    copy,
    projectCopy,
  });
  assert.deepEqual(entries[0].notes, ["Explicit session assignment"]);
  assert.equal(entries[0].locked, false);
  assert.equal(entries[1].action, undefined);
  assert.deepEqual(entries[1].notes, ["Project managed", "Explicit session assignment"]);
});
