import test from "node:test";
import assert from "node:assert/strict";
import { memoryEntries } from "../../server/features/assistants/memory-entries.js";

const texts = (runtime, content) =>
  memoryEntries(runtime, "MEMORY.md", content).map((e) => e.text);

test("an OpenClaw entry is a list item or a paragraph line; headings are none", () => {
  const content = [
    "# Memory",
    "",
    "- The owner writes German.",
    "* Repository under ~/Projects/agent-pier.",
    "1. First numbered rule.",
    "",
    "## Limits",
    "A paragraph line.",
    "Another paragraph line.",
  ].join("\n");
  assert.deepEqual(texts("openclaw", content), [
    "The owner writes German.",
    "Repository under ~/Projects/agent-pier.",
    "First numbered rule.",
    "A paragraph line.",
    "Another paragraph line.",
  ]);
});

test("a list item keeps its indented continuation lines", () => {
  const content = "- No keyloggers,\n  not even for the own Mac.\n- Next item.\n";
  const entries = memoryEntries("openclaw", "MEMORY.md", content);
  assert.deepEqual(
    entries.map((e) => e.text),
    ["No keyloggers,\n  not even for the own Mac.", "Next item."],
  );
  // start and end cover the whole item, marker and continuation included.
  assert.equal(
    content.slice(entries[0].start, entries[0].end),
    "- No keyloggers,\n  not even for the own Mac.",
  );
  assert.equal(content.slice(entries[1].start, entries[1].end), "- Next item.");
});

test("a paragraph line's span is its text; Windows line ends stay out", () => {
  const content = "# T\r\n  Fact one.  \r\n- Item\r\n";
  const entries = memoryEntries("openclaw", "notes.md", content);
  assert.deepEqual(
    entries.map((e) => [e.text, content.slice(e.start, e.end)]),
    [
      ["Fact one.", "Fact one."],
      ["Item", "- Item"],
    ],
  );
});

test("a Hermes entry is one §-delimited block, trimmed", () => {
  const content = "﻿First fact.\n§\n  Second\nwith two lines. \n§\n\n§\nThird.";
  const entries = memoryEntries("hermes", "MEMORY.md", content);
  assert.deepEqual(
    entries.map((e) => e.text),
    ["First fact.", "Second\nwith two lines.", "Third."],
  );
  for (const e of entries) assert.equal(content.slice(e.start, e.end), e.text);
});

test("empty or missing content has no entries", () => {
  assert.deepEqual(memoryEntries("openclaw", "MEMORY.md", ""), []);
  assert.deepEqual(memoryEntries("hermes", "MEMORY.md", undefined), []);
});
