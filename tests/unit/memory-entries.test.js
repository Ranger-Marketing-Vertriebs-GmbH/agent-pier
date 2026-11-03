import test from "node:test";
import assert from "node:assert/strict";
import {
  memoryEntries,
  withoutEntries,
} from "../../server/features/assistants/memory-entries.js";

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

const without = (runtime, content, texts) =>
  withoutEntries(runtime, "MEMORY.md", content, texts);

test("splits list items, paragraphs and Hermes blocks", () => {
  const content = "# Memory\n- One.\n- Two,\n  continued.\nA paragraph.\n";
  assert.deepEqual(texts("openclaw", content), [
    "One.",
    "Two,\n  continued.",
    "A paragraph.",
  ]);
  assert.deepEqual(texts("hermes", "One.\n§\nTwo.\n§\nThree."), [
    "One.",
    "Two.",
    "Three.",
  ]);
});

test("removing an entry keeps every other byte", () => {
  const content =
    "# Memory\n\n- One.\n- Two,\n  continued.\n\n  A paragraph.  \n## End\n";
  assert.equal(
    without("openclaw", content, ["Two,\n  continued."]),
    "# Memory\n\n- One.\n\n  A paragraph.  \n## End\n",
  );
  assert.equal(
    without("openclaw", content, ["A paragraph."]),
    "# Memory\n\n- One.\n- Two,\n  continued.\n\n## End\n",
  );
  // An unknown text and a heading's text remove nothing.
  assert.equal(without("openclaw", content, ["Memory", "Three."]), content);
});

test("removing every entry under a heading keeps the heading", () => {
  const content = "# Keep\n- A\n## Limits\n- B\n- C\n## Next\n- D\n";
  assert.equal(
    without("openclaw", content, ["B", "C"]),
    "# Keep\n- A\n## Limits\n## Next\n- D\n",
  );
});

test("a last line without a line break takes the one before it", () => {
  assert.equal(without("openclaw", "- A\r\n- B", ["B"]), "- A");
  assert.equal(without("openclaw", "- A\n- B\n- C", ["B", "C"]), "- A");
  assert.equal(without("openclaw", "\uFEFF- A", ["A"]), "\uFEFF");
  assert.equal(without("openclaw", "- A\r\n- B\r\n", ["A"]), "- B\r\n");
});

test("removes every copy of a text", () => {
  assert.equal(without("openclaw", "- A\n- B\n- A\n", ["A"]), "- B\n");
});

test("removing a Hermes block takes one separator", () => {
  const content = "One.\n§\n  Two\nlines. \n§\nThree.";
  assert.equal(without("hermes", content, ["Two\nlines."]), "One.\n§\nThree.");
  assert.equal(without("hermes", content, ["One."]), "  Two\nlines. \n§\nThree.");
  assert.equal(without("hermes", content, ["Three."]), "One.\n§\n  Two\nlines. ");
  assert.equal(without("hermes", content, ["Two\nlines.", "Three."]), "One.");
  assert.equal(without("hermes", "Only.", ["Only."]), "");
});
