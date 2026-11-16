import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { observeClaude } from "../../server/features/chat/chat-observability.js";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import { ClaudeHistoryMetadata } from "../../server/features/chat/claude-history-metadata.js";

// Real Claude Code 2.1.326 records (sanitized): a background subagent starts its own
// background `sleep`, stops while it runs (interim notification), resumes when the
// shell ends and finishes (final notification without a <tool-use-id>).
const { main, subagent } = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/observability/claude-subagent-waiting.json", import.meta.url),
    "utf8",
  ),
);
const AGENT = "a0fixture0waiter1";
const CALL = "toolu_fixture_agent_call";
const interim = main.findIndex(
  (record) => record.type === "user" && record.origin?.runId === "run-1",
);
const untilInterim = main.slice(0, interim + 1);

const agentOf = (snapshot) => snapshot.subagents.find((agent) => agent.id === AGENT);
const observers = (records) => [
  observeClaude(records),
  new ClaudeHistoryMetadata().update(records).snapshot().observability,
];
const rowStatus = (records) =>
  normalizeClaude(records).messages.find((message) => message.id === CALL).status;

test("a subagent waiting on its own background shell stays running until its final notification", () => {
  for (const snapshot of observers(untilInterim))
    assert.equal(agentOf(snapshot).status, "running");
  assert.equal(rowStatus(untilInterim), "running");
  for (const snapshot of observers(main)) {
    const agent = agentOf(snapshot);
    assert.equal(agent.status, "completed");
    assert.equal(agent.toolUseId, CALL);
    assert.equal(agent.usage.durationMs, 33208);
  }
  assert.equal(rowStatus(main), "completed");
});

test("the subagent's own background shell is not a main-loop shell", () => {
  assert.deepEqual(observeClaude([...main, ...subagent]).shells, []);
  assert.deepEqual(observeClaude([...untilInterim, ...subagent]).shells, []);
});

test("only the CLI's envelope note marks a notification as interim", () => {
  const final = main.at(-1);
  // The waiting note quoted inside the agent's own result is prose, not evidence.
  const quoted = structuredClone(final);
  quoted.message.content = quoted.message.content
    .replace(/<note>[\s\S]*?<\/note>\n/, "")
    .replace(
      "<result>Fixture report.</result>",
      "<result><note>This agent stopped with background work of its own still running.</note></result>",
    );
  assert.equal(agentOf(observeClaude([...untilInterim, quoted])).status, "completed");
  // A notification without a <tool-use-id> only ends an agent this session launched.
  const stranger = structuredClone(final);
  stranger.message.content = stranger.message.content.replaceAll(
    AGENT,
    "aunknownagent01",
  );
  assert.equal(
    observeClaude([...untilInterim, stranger]).subagents.some(
      (agent) => agent.id === "aunknownagent01",
    ),
    false,
  );
});
