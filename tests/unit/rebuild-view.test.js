import test from "node:test";
import assert from "node:assert/strict";
import {
  activityRevision,
  freshQuestions,
  pausedFields,
  rebuildView,
  rebuildStatus,
  rebuildStep,
  sampledFields,
} from "../../server/features/craft/rebuild-view.js";

test("Craft Anything's statuses map to a rebuild's status", () => {
  const table = [
    ["building", true, "building"],
    ["needs_you", true, "needs_you"],
    ["ready", false, "ready"],
    ["stopped", false, "paused"],
    ["checking", true, "checking"],
    ["failed", false, "failed"],
    ["build_error", false, "failed"],
    ["something_new", true, "building"],
    ["something_new", false, "paused"],
    [undefined, false, "paused"],
  ];
  for (const [craft, running, status] of table)
    assert.equal(rebuildStatus(craft, running), status, `${craft} running=${running}`);
});

test("the step follows the status and note", () => {
  const table = [
    ["ready", "All done", "ready"],
    ["checking", null, "check"],
    ["starting", null, "study"],
    ["building", "Building the first version…", "build"],
    ["building", "Studying the target", "study"],
    ["building", "Capturing the page", "study"],
    ["building", "Comparing with the target", "check"],
    ["needs_you", "Which colour?", "build"],
    ["paused", null, "build"],
  ];
  for (const [status, note, step] of table)
    assert.equal(rebuildStep(status, note), step, `${status} ${note}`);
});

test("a sample becomes the view's fields", () => {
  const fields = sampledFields(
    {
      running: true,
      queued: false,
      status: "needs_you",
      status_label: "Needs you",
      note: "Which colour?",
      waiting: 1,
      last_check: { similarity: 0.82 },
    },
    {
      status: "needs_you",
      checks: [{ name: "build", passed: true }],
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01 },
      last_reply: "Hi",
      questions: [
        {
          id: "q1",
          kind: "question",
          title: "Which colour?",
          choices: ["Red"],
          allow_text: true,
        },
        { id: "q2", kind: "approval", title: "Run?", action: "npm install" },
      ],
    },
    null,
    // q2 was open at the previous sample; q1 is new.
    [{ id: "q2", askedAt: "2026-11-08T10:00:00.000Z" }],
    "2026-11-08T10:05:00.000Z",
  );
  assert.equal(fields.running, true);
  assert.equal(fields.status, "needs_you");
  assert.equal(fields.statusLabel, "Needs you");
  assert.equal(fields.similarity, 0.82);
  assert.deepEqual(fields.usage, { inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
  assert.equal(fields.lastReply, "Hi");
  assert.deepEqual(fields.questions[0], {
    id: "q1",
    kind: "question",
    title: "Which colour?",
    detail: "",
    choices: ["Red"],
    allowText: true,
    action: null,
    askedAt: "2026-11-08T10:05:00.000Z",
  });
  assert.equal(fields.questions[1].kind, "approval");
  assert.equal(fields.questions[1].askedAt, "2026-11-08T10:00:00.000Z");
  assert.equal(fields.questions[1].action, "npm install");
  const stopped = sampledFields({ running: false, status: "stopped" }, {});
  assert.equal(stopped.status, "paused");
  assert.deepEqual(stopped.questions, []);
});

test("a paused or failed rebuild keeps the step it reached", () => {
  const show = { checks: [] };
  const paused = sampledFields(
    { running: false, status: "stopped", note: "x" },
    show,
    "check",
  );
  assert.equal(paused.step, "check");
  const failed = sampledFields({ running: false, status: "failed" }, show, "study");
  assert.equal(failed.step, "study");
  const building = sampledFields({ running: true, status: "building" }, show, "check");
  assert.equal(building.step, "build");
});

test("the view tells whether Craft Anything ever took the rebuild on", () => {
  const record = { id: "r1", status: "failed", craftProject: null, secret: "x" };
  assert.equal(rebuildView(record).started, false);
  assert.equal(rebuildView({ ...record, craftProject: "app" }).started, true);
  assert.equal("craftProject" in rebuildView(record), false);
  assert.equal("secret" in rebuildView(record), false);
});

test("a stopped build's questions stay hidden after it runs again", () => {
  const q = (id) => ({ id, kind: "approval", title: id });
  // Running: nothing stale yet.
  assert.deepEqual(freshQuestions([q("a")], true), {
    questions: [q("a")],
    staleQuestions: [],
  });
  // Stopped: every listed question is stale.
  const stopped = freshQuestions([q("a")], false);
  assert.deepEqual(stopped, { questions: [], staleQuestions: ["a"] });
  // Continued: "a" is asked again as "b"; Craft Anything still lists "a".
  assert.deepEqual(freshQuestions([q("a"), q("b")], true, stopped.staleQuestions), {
    questions: [q("b")],
    staleQuestions: ["a"],
  });
  // Once Craft Anything no longer lists "a", it is forgotten.
  assert.deepEqual(freshQuestions([q("b")], true, ["a"]).staleQuestions, []);
});

test("a rebuild paused without a sample lists no questions", () => {
  const fields = pausedFields({ questions: [{ id: "b" }], staleQuestions: ["a"] });
  assert.deepEqual(fields, {
    running: false,
    status: "paused",
    questions: [],
    staleQuestions: ["a", "b"],
  });
});

test("the activity revision follows the line count and the last line", () => {
  const one = activityRevision({ lines: ["06:03 note a"], total_lines_read: 5 });
  assert.match(one, /^[0-9a-f]{16}$/);
  assert.equal(activityRevision({ lines: ["06:03 note a"], total_lines_read: 5 }), one);
  assert.notEqual(
    activityRevision({ lines: ["06:03 note a"], total_lines_read: 6 }),
    one,
  );
  assert.notEqual(
    activityRevision({ lines: ["06:04 note b"], total_lines_read: 5 }),
    one,
  );
  assert.equal(activityRevision(null), activityRevision({ lines: [] }));
});
