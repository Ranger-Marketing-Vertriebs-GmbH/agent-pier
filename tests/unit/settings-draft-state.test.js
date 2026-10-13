import test from "node:test";
import assert from "node:assert/strict";
import {
  changedKeys,
  followRevisions,
  followServer,
  markSaved,
  settleSave,
} from "../../web/lib/settings/draft-state.js";

const base = { name: "Home", memory: false, team: 4 };

test("changed keys compare by value on both sides", () => {
  assert.deepEqual(changedKeys({ ...base }, base), []);
  assert.deepEqual(changedKeys({ ...base, name: "Office" }, base), ["name"]);
  const { team: _team, ...withoutTeam } = base;
  assert.deepEqual(changedKeys(withoutTeam, base), ["team"]);
});

test("untouched fields adopt server values and edited fields stay", () => {
  const draft = { values: { ...base, name: "Office" }, base };
  const next = followServer(draft, { ...base, memory: true });
  assert.deepEqual(next.values, { name: "Office", memory: true, team: 4 });
  assert.deepEqual(next.base, { name: "Home", memory: true, team: 4 });
  assert.deepEqual(next.conflicts, []);
});

test("a field edited here and changed on the server is a conflict", () => {
  const draft = { values: { ...base, name: "Office" }, base };
  const next = followServer(draft, { ...base, name: "Studio" });
  assert.equal(next.values.name, "Office");
  assert.deepEqual(next.conflicts, ["name"]);
});

test("a server value equal to the edit settles the field", () => {
  const draft = { values: { ...base, name: "Office" }, base };
  const next = followServer(draft, { ...base, name: "Office" });
  assert.deepEqual(changedKeys(next.values, next.base), []);
});

test("an unchanged server keeps the same objects", () => {
  const draft = { values: { ...base }, base };
  const next = followServer(draft, { ...base });
  assert.equal(next.values, draft.values);
  assert.equal(next.base, draft.base);
});

test("saved keys move into the base and revisions only grow", () => {
  const values = { ...base, name: "Office", team: 6 };
  assert.deepEqual(markSaved(base, values, ["name"]), { ...base, name: "Office" });
  assert.deepEqual(
    followRevisions({ agent: 5, team: 2 }, { agent: 4, team: 3, access: 1 }),
    {
      agent: 5,
      team: 3,
      access: 1,
    },
  );
});

const saving = { name: "Home", memory: false, team: 4 };
const submitted = { name: "  Office ", memory: false, team: 4 };
const allKeys = Object.keys(submitted);

test("a save the server already reflects adopts the stored values", () => {
  const draft = { values: submitted, base: saving };
  const server = { ...saving, name: "Office" };
  const next = settleSave({
    draft,
    submitted,
    savedKeys: allKeys,
    before: saving,
    server,
  });
  assert.deepEqual(next.values, server);
  assert.deepEqual(next.base, server);
});

test("a save the server does not reflect yet keeps the submitted values", () => {
  const draft = { values: submitted, base: saving };
  const next = settleSave({
    draft,
    submitted,
    savedKeys: allKeys,
    before: saving,
    server: saving,
  });
  assert.deepEqual(next.values, submitted);
  assert.deepEqual(next.base, submitted);
  const followed = followServer(next, { ...saving, name: "Office" });
  assert.deepEqual(followed.values, { ...saving, name: "Office" });
  assert.deepEqual(changedKeys(followed.values, followed.base), []);
  assert.deepEqual(followed.conflicts, []);
});

test("a field adopted during the save keeps the adopted base", () => {
  const server = { ...saving, name: "Office", memory: true };
  const draft = {
    values: { ...submitted, memory: true },
    base: { ...saving, memory: true },
  };
  const next = settleSave({
    draft,
    submitted,
    savedKeys: allKeys,
    before: saving,
    server,
  });
  assert.deepEqual(next.values, server);
  assert.deepEqual(next.base, server);
});

test("a field edited during the save keeps the newer edit and stays dirty", () => {
  const draft = { values: { ...submitted, team: 7 }, base: saving };
  const server = { ...saving, name: "Office", team: 4 };
  const next = settleSave({
    draft,
    submitted,
    savedKeys: allKeys,
    before: saving,
    server,
  });
  assert.equal(next.values.team, 7);
  assert.equal(next.values.name, "Office");
  assert.deepEqual(changedKeys(next.values, next.base), ["team"]);
});

test("a partial save marks only saved keys and keeps bases adopted meanwhile", () => {
  const draft = {
    values: { ...submitted, memory: true, team: 6 },
    base: { ...saving, memory: true },
  };
  const values = { ...submitted, team: 6 };
  const next = settleSave({
    draft,
    submitted: values,
    savedKeys: ["name"],
    before: saving,
    server: { ...saving, name: "Office", memory: true },
  });
  assert.deepEqual(next.base, { ...saving, name: "Office", memory: true });
  assert.deepEqual(next.values, { ...draft.values, name: "Office" });
  assert.deepEqual(changedKeys(next.values, next.base), ["team"]);
});

test("a partial save does not reset a step key adopted during the save", () => {
  // The finished step owned name and memory; memory changed elsewhere meanwhile.
  const draft = {
    values: { ...submitted, memory: true, team: 6 },
    base: { ...saving, memory: true },
  };
  const next = settleSave({
    draft,
    submitted: { ...submitted, team: 6 },
    savedKeys: ["name", "memory"],
    before: saving,
    server: { ...saving, name: "Office", memory: true },
  });
  assert.equal(next.values.memory, true);
  assert.equal(next.base.memory, true);
  assert.deepEqual(changedKeys(next.values, next.base), ["team"]);
});
