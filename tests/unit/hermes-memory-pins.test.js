import test from "node:test";
import assert from "node:assert/strict";
import {
  memoryLimits,
  pinned,
  pinnedChars,
  pinnedEntries,
} from "../../server/features/assistants/runtimes/hermes/hermes-config/memory.js";

test("Hermes memory has room for 10000 and 5000 characters", () =>
  assert.deepEqual(memoryLimits, { "MEMORY.md": 10000, "USER.md": 5000 }));

test("pinned entries are those that start with the marker", () => {
  const text = "📌 Owner drinks tea\n§\nVault at /srv\n§\n  📌 Kid is called Ada  ";
  assert.deepEqual(pinnedEntries(text), ["📌 Owner drinks tea", "📌 Kid is called Ada"]);
  assert.equal(pinned("A 📌 inside"), false);
  assert.equal(
    pinnedChars(text),
    [..."📌 Owner drinks tea\n§\n📌 Kid is called Ada"].length,
  );
});
