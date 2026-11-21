import test from "node:test";
import assert from "node:assert/strict";
import { observeClaude } from "../../server/features/chat/chat-observability.js";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import { ClaudeHistoryMetadata } from "../../server/features/chat/claude-history-metadata.js";
import {
  backgroundShell,
  compaction,
  launch,
  notification,
  reply,
} from "../helpers/claude-subagents.js";

// After a context compaction Claude Code does not send <task-notification>
// envelopes for what finished meanwhile. It lists every background task it still
// tracks as a `task_status` attachment right after the continuation prompt.

/** An interim notification: the agent stopped while its own background work runs. */
const waiting = (callId, agentId) => {
  const record = notification(callId, agentId, "completed");
  record.message.content = record.message.content.replace(
    "</summary>\n",
    "</summary>\n<note>This agent stopped with background work of its own still running. It may resume on its own.</note>\n<result>Interim.</result>\n",
  );
  return record;
};

const observers = (records) => {
  const metadata = new ClaudeHistoryMetadata();
  // The metadata observer follows the transcript record by record, as live.
  for (const record of records) metadata.update([record]);
  return [observeClaude(records), metadata.snapshot().observability];
};
const statuses = (snapshot, kind = "subagents") =>
  Object.fromEntries(snapshot[kind].map((entry) => [entry.id, entry.status]));
const rowStatus = (records, callId) =>
  normalizeClaude(records).messages.find((message) => message.id === callId).status;

// The incident: two agents finished across a compaction, one stalled and was
// dropped by the CLI, one still works, one had finished long before.
const beforeCompaction = [
  ...launch("toolu_done", "adonemeanwhile01", "Fix mediums"),
  waiting("toolu_done", "adonemeanwhile01"),
  ...launch("toolu_gone", "agonestalled0001", "Fix flake"),
  waiting("toolu_gone", "agonestalled0001"),
  ...launch("toolu_live", "aliveandworking1", "Long review"),
  ...launch("toolu_old", "aoldfinished0001", "Old task"),
  notification("toolu_old", "aoldfinished0001", "completed"),
  ...backgroundShell("bkeeprunning", "Watch the release workflow"),
  ...backgroundShell("bdroppedshell", "Tail the logs"),
  ...backgroundShell("bfinishedshell", "Run the tests"),
];
const listed = compaction([
  { taskId: "adonemeanwhile01", status: "completed", description: "Fix mediums" },
  { taskId: "aliveandworking1", status: "running", description: "Long review" },
  {
    taskId: "bkeeprunning",
    taskType: "local_bash",
    status: "running",
    description: "Watch the release workflow",
  },
  {
    taskId: "bfinishedshell",
    taskType: "local_bash",
    status: "completed",
    description: "Run the tests",
  },
]);
const continued = [...beforeCompaction, ...listed, reply()];

test("a completion listed after a compaction settles its agent", () => {
  for (const snapshot of observers(continued))
    assert.equal(statuses(snapshot).adonemeanwhile01, "completed");
  assert.equal(rowStatus(continued, "toolu_done"), "completed");
});

test("an agent the CLI no longer lists after a compaction is no longer running", () => {
  for (const snapshot of observers(continued))
    assert.deepEqual(statuses(snapshot), {
      adonemeanwhile01: "completed",
      agonestalled0001: "unknown",
      aliveandworking1: "running",
      aoldfinished0001: "completed",
    });
});

test("shells follow the same compaction listing", () => {
  for (const snapshot of observers(continued))
    assert.deepEqual(statuses(snapshot, "shells"), {
      bkeeprunning: "running",
      bdroppedshell: "unknown",
      bfinishedshell: "completed",
    });
});

test("the listing settles unlisted tasks only once the continuation starts", () => {
  // Claude writes the attachments after the summary; until the conversation goes
  // on, a listing may still be arriving.
  const open = [...beforeCompaction, ...listed];
  for (const snapshot of observers(open)) {
    assert.equal(statuses(snapshot).agonestalled0001, "running");
    assert.equal(statuses(snapshot).adonemeanwhile01, "completed");
  }
});

test("agents launched after a compaction are not settled by its listing", () => {
  const records = [
    ...continued,
    ...launch("toolu_after", "aafterboundary01", "Next task"),
    reply("Launched."),
  ];
  for (const snapshot of observers(records))
    assert.equal(statuses(snapshot).aafterboundary01, "running");
});

test("a compaction without any listing settles every running task", () => {
  const records = [...beforeCompaction, ...compaction([]), reply()];
  for (const snapshot of observers(records)) {
    assert.equal(statuses(snapshot).aliveandworking1, "unknown");
    assert.equal(statuses(snapshot).aoldfinished0001, "completed");
    assert.equal(statuses(snapshot, "shells").bkeeprunning, "unknown");
  }
});

test("a sidechain listing never settles the main conversation's tasks", () => {
  const sidechain = compaction([
    { taskId: "agonestalled0001", status: "completed", description: "Fix flake" },
  ]).map((record) => ({ ...record, isSidechain: true }));
  const records = [...beforeCompaction, ...sidechain, { ...reply(), isSidechain: true }];
  for (const snapshot of observers(records))
    assert.equal(statuses(snapshot).agonestalled0001, "running");
});

test("an agent launched without a type shows Claude's default type and its description", () => {
  const records = [
    ...launch("toolu_untyped", "auntypedagent001", "Re-verify fixes", {
      description: "Re-verify fixes",
      prompt: "Check the fixes in the UI.",
    }),
    ...compaction([
      { taskId: "auntypedagent001", status: "completed", description: "Re-verify fixes" },
    ]),
    reply(),
  ];
  for (const snapshot of observers(records)) {
    const agent = snapshot.subagents.find((entry) => entry.id === "auntypedagent001");
    assert.equal(agent.name, "general-purpose");
    assert.equal(agent.task, "Re-verify fixes");
    assert.equal(agent.status, "completed");
  }
  const row = normalizeClaude(records).messages.find(
    (message) => message.id === "toolu_untyped",
  );
  assert.equal(row.subagent.type, "general-purpose");
  assert.equal(row.subagent.description, "Re-verify fixes");
});
