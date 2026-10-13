import test from "node:test";
import assert from "node:assert/strict";
import { ArtifactNames } from "../../server/features/artifacts/artifact-names.js";

test("artifact search reads the name table at most once per interval", async () => {
  let time = 0,
    reads = 0;
  const names = new ArtifactNames({
    sessions: () => {
      reads++;
      return [{ id: "s1", name: "Nightly ETL review" }];
    },
    projects: () => [{ id: "p1", name: "Shop-Frontend" }],
    ttlMs: 5000,
    clock: () => time,
  });
  assert.deepEqual(await names.matches("nightly"), ["s1"]);
  assert.deepEqual(await names.matches("SHOP"), ["p1"]);
  assert.deepEqual(await names.matches("e"), ["s1", "p1"]);
  assert.equal(reads, 1);
  time = 5000;
  await names.matches("nightly");
  assert.equal(reads, 2);
});

test("an unreadable name source narrows search to the other source", async () => {
  const names = new ArtifactNames({
    sessions: () => {
      throw new Error("busy");
    },
    projects: async () => {
      throw new Error("locked");
    },
  });
  assert.deepEqual(await names.matches("x"), []);
  const partial = new ArtifactNames({
    sessions: async () => [{ id: "s1", name: "Report run" }, null, { id: "s2" }],
    projects: () => undefined,
  });
  assert.deepEqual(await partial.matches("report"), ["s1"]);
});
