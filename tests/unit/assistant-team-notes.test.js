import test from "node:test";
import assert from "node:assert/strict";
import {
  foldResultEvents,
  teamNotes,
  teamOutcome,
  withTeamNotes,
} from "../../web/features/assistants/team-notes.js";

const iso = (s) => new Date(s * 1000).toISOString();
const team = (id, overrides = {}) => ({
  id,
  parentAssistantId: "lead",
  parentConversationId: "chat",
  objective: id,
  phase: "running",
  createdAt: iso(10),
  ...overrides,
});
const where = { assistantId: "lead", conversationId: "chat" };
const kinds = (notes) => notes.map((n) => `${n.team.id}:${n.kind}@${n.time / 1000}`);

test("teams note their start and their outcome at the recorded times", () => {
  const notes = teamNotes(
    [
      team("done", { phase: "completed", status: "completed", finishedAt: iso(30) }),
      team("mixed", {
        phase: "failed",
        status: "partial",
        createdAt: iso(5),
        finishedAt: iso(40),
      }),
      team("stopped", {
        phase: "cancelled",
        status: "cancelled",
        createdAt: iso(20),
        finishedAt: iso(25),
      }),
      team("running", { createdAt: iso(50) }),
    ],
    where,
  );
  assert.deepEqual(kinds(notes), [
    "mixed:started@5",
    "done:started@10",
    "stopped:started@20",
    "stopped:cancelled@25",
    "done:completed@30",
    "mixed:partial@40",
    "running:started@50",
  ]);
});

test("proposals never start; a declined one notes only its decline", () => {
  const notes = teamNotes(
    [
      team("waiting", { phase: "awaiting_approval" }),
      team("declined", { phase: "declined", finishedAt: iso(12) }),
    ],
    where,
  );
  assert.deepEqual(kinds(notes), ["declined:declined@12"]);
  assert.equal(teamOutcome({ phase: "declined", status: "declined" }), "declined");
  assert.equal(teamOutcome({ phase: "running", status: "stopping" }), null);
});

test("an ended team without a recorded end sits beside its start", () => {
  const notes = teamNotes(
    [team("old", { phase: "completed", status: "completed" })],
    where,
  );
  assert.deepEqual(kinds(notes), ["old:started@10", "old:completed@10"]);
});

test("only the lead's teams of this conversation are noted", () => {
  const notes = teamNotes(
    [
      team("other-lead", { parentAssistantId: "someone" }),
      team("other-chat", { parentConversationId: "elsewhere" }),
      team("unknown-chat", { parentConversationId: undefined }),
      team("no-time", { createdAt: undefined }),
    ],
    where,
  );
  assert.deepEqual(kinds(notes), ["unknown-chat:started@10"]);
});

test("notes interleave with messages by time and skip unloaded history", () => {
  const messages = [
    { id: "a", timestamp: 20000 },
    { id: "untimed", timestamp: 0 },
    { id: "b", timestamp: 40000 },
  ];
  const notes = [5, 30, 60].map((s) => ({ id: `n${s}`, time: s * 1000 }));
  const order = (items) => items.map((i) => i.message?.id ?? i.note.id);
  assert.deepEqual(order(withTeamNotes(messages, notes)), [
    "n5",
    "a",
    "untimed",
    "n30",
    "b",
    "n60",
  ]);
  // With older pages still to load, n5 belongs to them.
  assert.deepEqual(order(withTeamNotes(messages, notes, { complete: false })), [
    "a",
    "untimed",
    "n30",
    "b",
    "n60",
  ]);
  assert.deepEqual(order(withTeamNotes([], notes, { complete: false })), [
    "n5",
    "n30",
    "n60",
  ]);
});

test("a team starts when it was started, older teams at their proposal", () => {
  const notes = teamNotes(
    [
      team("approved-later", { startedAt: iso(90) }),
      team("legacy", { createdAt: iso(20) }),
    ],
    where,
  );
  assert.deepEqual(kinds(notes), ["legacy:started@20", "approved-later:started@90"]);
});

test("the synthesis event folds into the end note it directly follows", () => {
  const end = (kind) => ({ note: { id: kind, kind } });
  const event = (id) => ({ message: { id, role: "event", event: "team-result" } });
  const order = (items) => items.map((i) => i.message?.id ?? i.note.id);
  assert.deepEqual(
    order(
      foldResultEvents([
        end("completed"),
        event("e1"),
        end("started"),
        event("e2"),
        { message: { id: "reply", role: "assistant" } },
        event("e3"),
        end("partial"),
        { message: { id: "coding", role: "event", event: "coding-result" } },
      ]),
    ),
    ["completed", "started", "e2", "reply", "e3", "partial", "coding"],
  );
});

test("a synthesis that could not be sent leaves a note after the team's end", () => {
  const notes = teamNotes(
    [
      team("unsent", {
        phase: "completed",
        status: "completed",
        finishedAt: iso(30),
        resultState: "unsent",
      }),
    ],
    where,
  );
  assert.deepEqual(kinds(notes), [
    "unsent:started@10",
    "unsent:completed@30",
    "unsent:unsent@30",
  ]);
});
