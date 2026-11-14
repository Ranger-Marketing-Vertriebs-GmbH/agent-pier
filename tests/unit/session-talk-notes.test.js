import test from "node:test";
import assert from "node:assert/strict";
import { talkNotes } from "../../server/features/assistants/session-talk/talk-notes.js";

const base = {
  conversationId: "c1",
  sessionName: "Deploy",
  projectName: "homelab",
  createdAt: 1000,
};
const rows = [
  {
    ...base,
    id: "a",
    op: "send",
    direction: "to-session",
    status: "accepted",
    text: "hi",
  },
  {
    ...base,
    id: "b",
    op: "late",
    direction: "to-session",
    phase: "late-delivered",
    text: "x",
  },
  {
    ...base,
    id: "c",
    op: "late",
    direction: "to-session",
    phase: "late-dropped",
    text: "",
  },
  { ...base, id: "d", op: "limit", direction: "to-agent", phase: "noted" },
  { ...base, id: "e", op: "ask", direction: "to-agent", text: "q" },
  { ...base, id: "f", op: "send", direction: "to-session", conversationId: "c2" },
  {
    ...base,
    id: "g",
    op: "send",
    direction: "to-session",
    status: "pending",
    text: "y".repeat(900),
  },
];

test("talk rows become quiet notes of their own chat", () => {
  const notes = talkNotes(rows, "c1");
  assert.deepEqual(
    notes.map((n) => [n.id, n.op, n.outcome]),
    [
      ["session-talk:a", "send", "accepted"],
      ["session-talk:b", "late", null],
      ["session-talk:c", "late", "dropped"],
      ["session-talk:d", "limit", null],
      ["session-talk:g", "send", "pending"],
    ],
  );
  assert.deepEqual(notes[0], {
    id: "session-talk:a",
    role: "event",
    event: "session-talk",
    op: "send",
    sessionName: "Deploy",
    projectName: "homelab",
    text: "hi",
    outcome: "accepted",
    timestamp: 1000,
    runId: null,
  });
  assert.equal("text" in notes[3], false);
  assert.equal(notes[4].text.length, 500);
});
