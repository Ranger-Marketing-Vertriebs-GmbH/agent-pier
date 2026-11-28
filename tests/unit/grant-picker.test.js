import test from "node:test";
import assert from "node:assert/strict";
import {
  addGrants,
  allowedEntries,
  grantCandidates,
  isAllowed,
  pinnedFirst,
  setGrant,
} from "../../web/components/grant-picker.js";

// The rules of the grant picker: which entries count as allowed, and how a click on
// the switch or the add field changes the list of explicitly granted ids.
const entries = [
  { id: "a", name: "A" },
  { id: "b", name: "B", locked: true },
  { id: "c", name: "C", sub: "u@c:22", group: "g" },
];

test("locked and selected entries are allowed, in entry order", () => {
  assert.deepEqual(
    allowedEntries(entries, ["c"]).map((e) => e.id),
    ["b", "c"],
  );
  assert.equal(isAllowed(entries[0], ["c"]), false);
});

test("setGrant appends once and removes", () => {
  assert.deepEqual(setGrant(["c"], "a", true), ["c", "a"]);
  assert.deepEqual(setGrant(["c", "a"], "a", true), ["c", "a"]);
  assert.deepEqual(setGrant(["c", "a"], "c", false), ["a"]);
});

test("removing an explicit id keeps a locked entry allowed", () => {
  const next = setGrant(["b"], "b", false);
  assert.deepEqual(next, []);
  assert.equal(isAllowed(entries[1], next), true);
});

test("unknown selected ids are kept", () => {
  assert.deepEqual(setGrant(["gone", "c"], "a", true), ["gone", "c", "a"]);
  assert.deepEqual(
    allowedEntries(entries, ["gone"]).map((e) => e.id),
    ["b"],
  );
});

test("addGrants adds several without duplicates", () => {
  assert.deepEqual(addGrants(["a"], ["a", "c"]), ["a", "c"]);
});

test("grantCandidates keeps only the AddPicker fields", () => {
  assert.deepEqual(grantCandidates([entries[2]]), [
    { id: "c", name: "C", sub: "u@c:22", group: "g" },
  ]);
});

test("grantCandidates shows a badge as the group when the entry has none", () => {
  const sftp = { id: "s", name: "S", sub: "u@s:22", badge: "SFTP", locked: true };
  assert.deepEqual(grantCandidates([sftp, { ...sftp, group: "g" }]), [
    { id: "s", name: "S", sub: "u@s:22", group: "SFTP" },
    { id: "s", name: "S", sub: "u@s:22", group: "g" },
  ]);
});

test("pinnedFirst moves the given ids to the top and keeps both orders", () => {
  assert.deepEqual(
    pinnedFirst(entries, ["c", "gone"]).map((entry) => entry.id),
    ["c", "a", "b"],
  );
  assert.equal(pinnedFirst(entries, []), entries);
});
