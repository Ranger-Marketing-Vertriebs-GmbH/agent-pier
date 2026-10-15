import test from "node:test";
import assert from "node:assert/strict";
import { streamInHistory } from "../../web/features/assistants/stream-reply.js";

const reply = (runId, text) => ({
  id: `${runId}-${text}`,
  role: "assistant",
  runId,
  text,
});
const running = (attempt) => [{ id: "q1", state: "accepted", attempt }];

test("a stored reply of the delta's run covers the stream", () => {
  const history = { messages: [reply("r1", "Done.\n")], requests: [] };
  assert.equal(streamInHistory({ runId: "r1", text: "Done." }, history), true);
});

test("the latest attempt's id or runtime run id identifies the run", () => {
  const messages = [reply("a1", "Done.")];
  assert.equal(
    streamInHistory({ text: "Done." }, { messages, requests: running({ id: "a1" }) }),
    true,
  );
  assert.equal(
    streamInHistory(
      { text: "Done." },
      {
        messages: [reply("r9", "Done.")],
        requests: running({ id: "a1", runtimeRunId: "r9" }),
      },
    ),
    true,
  );
});

test("another run's identical reply does not hide the stream", () => {
  const history = { messages: [reply("old", "OK")], requests: running({ id: "a1" }) };
  assert.equal(streamInHistory({ runId: "a1", text: "OK" }, history), false);
});

test("an earlier reply of the same run keeps streaming text visible", () => {
  const history = { messages: [reply("r1", "Let me check.")], requests: [] };
  assert.equal(
    streamInHistory({ runId: "r1", text: "Let me check. Pasta tonight." }, history),
    false,
  );
  assert.equal(streamInHistory({ runId: "r1", text: "Pasta tonight." }, history), false);
});

test("a stream without a run or text is never covered", () => {
  const history = { messages: [reply(null, "Done.")], requests: [] };
  assert.equal(streamInHistory({ text: "Done." }, history), false);
  assert.equal(streamInHistory(null, history), false);
});
