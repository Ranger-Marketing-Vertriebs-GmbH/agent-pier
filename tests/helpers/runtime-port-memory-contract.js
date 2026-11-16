import test from "node:test";
import assert from "node:assert/strict";

/**
 * The contract of `agentFiles.memory` (agent-runtime.js), the pure part of the
 * agentFiles sub-port: how a runtime writes its memory files. For every runtime's
 * memory format with or without a host; `make()` resolves `{ memory }`.
 */
export function memoryContract(name, make) {
  test(`${name}: memory.appended adds one entry that memory.entries reads back`, async () => {
    const { memory } = await make();
    assert.ok(Object.isFrozen(memory));
    assert.deepEqual(memory.entries(""), []);
    assert.deepEqual(memory.entries(undefined), []);
    const one = memory.appended("", "Quartz is grey.");
    assert.deepEqual(
      memory.entries(one).map((entry) => entry.text),
      ["Quartz is grey."],
    );
    const two = memory.appended(one, "Slate splits.");
    assert.ok(two.startsWith(one.trimEnd()));
    const entries = memory.entries(two);
    assert.deepEqual(
      entries.map((entry) => entry.text),
      ["Quartz is grey.", "Slate splits."],
    );
    // start and end span the whole entry, its text included.
    for (const { text, start, end } of entries) {
      assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end));
      assert.ok(two.slice(start, end).endsWith(text), text);
    }
    assert.ok(entries[0].end <= entries[1].start);
  });

  test(`${name}: memory.without removes exactly the named entries`, async () => {
    const { memory } = await make();
    const content = ["One.", "Two.", "Three."].reduce(
      (text, entry) => memory.appended(text, entry),
      "",
    );
    const texts = (text) => memory.entries(text).map((entry) => entry.text);
    assert.equal(memory.without(content, []), content);
    assert.equal(memory.without(content, ["Unknown."]), content);
    assert.deepEqual(texts(memory.without(content, ["Two."])), ["One.", "Three."]);
    assert.deepEqual(texts(memory.without(content, ["One.", "Three."])), ["Two."]);
    assert.deepEqual(texts(memory.without(content, ["One.", "Two.", "Three."])), []);
  });

  test(`${name}: memory.limit and memory.chars count a file against its limit`, async () => {
    const { memory } = await make();
    for (const file of ["MEMORY.md", "USER.md", "memory/2026-11-16.md"]) {
      const limit = memory.limit(file);
      assert.ok(limit === null || (Number.isSafeInteger(limit) && limit > 0), file);
    }
    assert.equal(memory.chars(""), 0);
    const one = memory.appended("", "Quartz");
    assert.ok(Number.isSafeInteger(memory.chars(one)) && memory.chars(one) >= 6);
    assert.ok(memory.chars(memory.appended(one, "Slate")) > memory.chars(one));
  });

  test(`${name}: memory.pinMarker is a marker text or null`, async () => {
    const { pinMarker } = (await make()).memory;
    assert.ok(pinMarker === null || (typeof pinMarker === "string" && pinMarker.length));
  });
}
