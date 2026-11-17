import test from "node:test";
import assert from "node:assert/strict";
import {
  appendStopNotes,
  carriedStopNoteIds,
  withStopNotes,
} from "../../web/features/chat/stop-notes.js";

const note = {
  id: "n1",
  text: '[AgentPier: the user stopped background task "reviewer" (agent1).]',
};
const other = {
  id: "n2",
  text: '[AgentPier: the user stopped background task "sleep 300" (shell1).]',
};

test("pending notes are appended after a blank line and named", () => {
  assert.deepEqual(appendStopNotes("go on", [note], new Set()), {
    text: `go on\n\n${note.text}`,
    stopNoteIds: ["n1"],
  });
  assert.deepEqual(appendStopNotes("go on", [note, other], new Set()), {
    text: `go on\n\n${note.text}\n${other.text}`,
    stopNoteIds: ["n1", "n2"],
  });
});

test("slash commands and shell lines never carry a note", () => {
  for (const text of ["/compact", "!ls", "  /model"])
    assert.deepEqual(appendStopNotes(text, [note], new Set()), { text, stopNoteIds: [] });
});

test("a note an earlier message carries is not appended again", () => {
  assert.deepEqual(appendStopNotes("go on", [note], new Set(["n1"])), {
    text: "go on",
    stopNoteIds: [],
  });
  assert.deepEqual(appendStopNotes("go on", [note, other], new Set(["n1"])), {
    text: `go on\n\n${other.text}`,
    stopNoteIds: ["n2"],
  });
});

test("a text that already holds the line names it without repeating it", () => {
  const text = `go on\n\n${note.text}`;
  assert.deepEqual(appendStopNotes(text, [note], new Set()), {
    text,
    stopNoteIds: ["n1"],
  });
});

test("a message that would grow past the limit stays unchanged", () => {
  const text = "x".repeat(32000 - 10);
  assert.deepEqual(appendStopNotes(text, [note], new Set()), { text, stopNoteIds: [] });
});

test("no notes or malformed notes leave the text alone", () => {
  assert.deepEqual(appendStopNotes("go on", undefined, new Set()), {
    text: "go on",
    stopNoteIds: [],
  });
  assert.deepEqual(appendStopNotes("go on", [{ id: 1 }, null], new Set()), {
    text: "go on",
    stopNoteIds: [],
  });
});

test("carried ids come from the outbox and recent items that were not rejected", () => {
  const carried = carriedStopNoteIds({
    outbox: { status: "waiting", stopNoteIds: ["a"] },
    recent: [
      { status: "handed-off", stopNoteIds: ["b"] },
      { status: "rejected", stopNoteIds: ["c"] },
      { status: "accepted" },
    ],
  });
  assert.deepEqual([...carried].sort(), ["a", "b"]);
  assert.deepEqual([...carriedStopNoteIds({ outbox: null, recent: [] })], []);
});

test("an absent delivery taken back into the composer no longer carries its notes", () => {
  const carried = carriedStopNoteIds({
    outbox: null,
    recent: [{ status: "absent", stopNoteIds: ["a"] }],
  });
  assert.deepEqual([...carried], []);
  // While it is still the outbox, its retry sends the same text with the note.
  const queued = carriedStopNoteIds({
    outbox: { status: "absent", stopNoteIds: ["a"] },
    recent: [],
  });
  assert.deepEqual([...queued], ["a"]);
});

test("attachment paths count towards the limit; a note that does not fit waits", () => {
  const attachments = [{ path: `/uploads/${"p".repeat(60)}` }];
  const draft = { text: "x".repeat(32000 - 100), attachments, recent: [] };
  assert.deepEqual(withStopNotes(draft, [note]), {
    text: draft.text,
    stopNoteIds: [],
  });
  const short = { text: "go on", attachments, recent: [] };
  assert.deepEqual(withStopNotes(short, [note]), {
    text: `go on\n\n${note.text}`,
    stopNoteIds: ["n1"],
  });
});
