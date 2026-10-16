import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  MemoryNotes,
  withMemoryNotes,
} from "../../server/features/assistants/memory-notes.js";

test("memory notes are kept once per key, bounded per conversation and merged in order", () => {
  const db = new DatabaseSync(":memory:");
  let now = 10;
  const notes = new MemoryNotes(db, () => now++);
  assert.equal(notes.record({ key: "a:x", conversationId: "c", reason: "flush" }), true);
  assert.equal(notes.record({ key: "a:x", conversationId: "c", reason: "flush" }), false);
  assert.throws(() => notes.record({ key: "b", conversationId: "c", reason: "other" }));
  for (let n = 0; n < 120; n++)
    notes.record({ key: `k${n}`, conversationId: "c", reason: "not-owner" });
  notes.record({ key: "elsewhere", conversationId: "d", reason: "lead-request" });
  const kept = notes.forConversation("c");
  assert.equal(kept.length, 100, "the newest hundred stay");
  assert.equal(kept.at(-1).id, "memory-note:k119");
  assert.deepEqual(Object.keys(kept[0]).sort(), [
    "event",
    "id",
    "reason",
    "role",
    "runId",
    "timestamp",
  ]);
  const [only] = notes.forConversation("d");
  const merged = withMemoryNotes(
    [
      { id: "m1", timestamp: 0 },
      { id: "m2", timestamp: 1000 },
    ],
    [only],
  );
  assert.deepEqual(
    merged.map((m) => m.id),
    ["m1", "memory-note:elsewhere", "m2"],
  );
  assert.deepEqual(withMemoryNotes([{ id: "m" }], [only], { from: 5000 }), [{ id: "m" }]);
});

test("flush day notes follow calendar days across daylight saving changes", async () => {
  const { flushDates } =
    await import("../../server/features/assistants/memory-flushes.js");
  // 00:30 on 30 March in Berlin, the night after the 23-hour day.
  assert.deepEqual(flushDates(Date.parse("2026-03-29T22:30:00Z"), "Europe/Berlin"), [
    "memory/2026-03-30.md",
    "memory/2026-03-29.md",
  ]);
  // 00:30 on 26 October, after the 25-hour day.
  assert.deepEqual(flushDates(Date.parse("2026-10-25T23:30:00Z"), "Europe/Berlin"), [
    "memory/2026-10-26.md",
    "memory/2026-10-25.md",
  ]);
  assert.deepEqual(flushDates(Date.parse("2026-01-05T12:00:00Z"), "UTC"), [
    "memory/2026-01-05.md",
    "memory/2026-01-04.md",
  ]);
  // An unknown zone falls back to the host's instead of failing.
  assert.equal(flushDates(Date.now(), "Not/AZone").length, 2);
});
