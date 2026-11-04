import test from "node:test";
import assert from "node:assert/strict";
import {
  lineRange,
  openableNote,
} from "../../web/features/assistants/settings/memory-match.js";

test("opens the root notes, the diary and notes under memory/ only", () => {
  for (const path of ["MEMORY.md", "USER.md", "DREAMS.md", "memory/2026-11-01.md"])
    assert.equal(openableNote(path), true, path);
  for (const path of [
    "/etc/passwd",
    "memory/../MEMORY.md",
    "memory/notes.txt",
    "notes/2026-11-01.md",
    "memory\\x.md",
    undefined,
  ])
    assert.equal(openableNote(path), false, String(path));
});

test("selects the matched lines of a note", () => {
  const content = "# Day\nBought milk\nRefused a keylogger\nTea";
  assert.deepEqual(lineRange(content, 2), { start: 6, end: 17 });
  assert.equal(
    content.slice(...Object.values(lineRange(content, 2, 3))),
    "Bought milk\nRefused a keylogger",
  );
  assert.deepEqual(lineRange(content, 4, 9), { start: 38, end: 41 });
  assert.deepEqual(lineRange(content, 99), { start: 41, end: 41 });
  assert.deepEqual(lineRange(content, undefined), { start: 0, end: 0 });
  assert.deepEqual(lineRange("", 1), { start: 0, end: 0 });
});
