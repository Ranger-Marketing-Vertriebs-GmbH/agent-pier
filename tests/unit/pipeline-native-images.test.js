import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { NativeEventReader } from "../../server/features/pipelines/native-reader.js";
import { NativePipelineDriver } from "../../server/features/pipelines/native-driver.js";
import { applyOutcome } from "../../server/features/pipelines/execution-stage.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-native-images-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "sessions"));
  const file = path.join(root, "sessions/session.events.jsonl");
  const identity = {
    sessionId: "session",
    runId: "run",
    nodeId: "review",
    attemptId: "attempt",
    turnId: "turn",
  };
  const session = {
    id: "session",
    tool: "claude",
    status: "stopped",
    exitCode: 0,
    pipeline: { ...identity, headless: true },
  };
  await fs.writeFile(
    path.join(root, "sessions/session.outcome.json"),
    JSON.stringify({ exitCode: 0, groupStopped: true }),
  );
  const driver = new NativePipelineDriver({
    dataDir: root,
    sessions: { get: async () => session },
  });
  return { root, file, identity, driver };
}

const imageEvent = (length) =>
  JSON.stringify({
    type: "user",
    session_id: "native-review",
    message: {
      content: [
        {
          type: "tool_result",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "A".repeat(length),
              },
            },
          ],
        },
      ],
    },
  });
const completed = JSON.stringify({
  type: "result",
  session_id: "native-review",
  is_error: false,
  subtype: "success",
  usage: { input_tokens: 123, output_tokens: 45 },
});

test("large screenshot events survive partial writes and restart before a successful review result", async (t) => {
  const { root, file, identity, driver } = await fixture(t);
  const event = imageEvent(2 * 1024 * 1024);
  const split = 1100000;
  await fs.writeFile(file, event.slice(0, split));
  const reader = new NativeEventReader(root);
  assert.equal((await reader.read("session", "claude")).incomplete, true);
  await fs.appendFile(file, event.slice(split) + "\n" + completed + "\n");
  const observed = await reader.read("session", "claude");
  assert.equal(observed.result, "completed");
  assert.equal(observed.incomplete, false);
  assert.deepEqual(observed.usage, { inputTokens: 123, outputTokens: 45 });
  const outcome = await driver.inspect(identity);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.isError, false);
  assert.equal(outcome.quiesced, true);
  assert.equal(outcome.nativeId, "native-review");
});

test("oversized image events remain bounded and expose a safe diagnostic to the pipeline", async (t) => {
  const { file, driver, identity } = await fixture(t);
  await fs.writeFile(file, imageEvent(16 * 1024 * 1024) + "\n" + completed + "\n");
  const outcome = await driver.inspect(identity);
  assert.equal(outcome.status, "failed");
  assert.equal(
    outcome.observationError,
    "Native event exceeds the 16 MiB observation limit.",
  );
  const node = { id: "review" };
  const attempt = { id: "turn" };
  const run = {
    nodes: [node],
    currentNodeId: "review",
    currentAttemptId: "turn",
    executionLog: [attempt],
  };
  await applyOutcome({ now: () => "now", store: { save: () => {} } }, run, outcome);
  assert.equal(run.status, "awaiting-human");
  assert.equal(node.failReason, "session-error");
  assert.equal(node.failDetail, outcome.observationError);
});

test("malformed events following a large image still fail validation", async (t) => {
  const { file, driver, identity } = await fixture(t);
  await fs.writeFile(
    file,
    imageEvent(2 * 1024 * 1024) + "\n{broken}\n" + completed + "\n",
  );
  const outcome = await driver.inspect(identity);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.observationError, "Native CLI emitted invalid JSONL.");
});

test("unexpected filesystem errors do not expose paths or sensitive messages", async (t) => {
  const { driver, identity } = await fixture(t);
  driver.reader.read = async () => {
    throw new Error("private path or provider secret");
  };
  const outcome = await driver.inspect(identity);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "Native output could not be validated.");
  assert.equal(outcome.observationError, undefined);
});
