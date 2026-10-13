import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatStreams,
  maxStreamText,
  nextChatText,
} from "../../server/features/assistants/chat-stream.js";

const snapshot = (runId, text, sessionKey = "s") => ({
  runId,
  sessionKey,
  state: "delta",
  deltaText: text,
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const append = (runId, deltaText, sessionKey = "s") => ({
  runId,
  sessionKey,
  state: "delta",
  deltaText,
});

test("two runs on one session keep their own baselines", () => {
  const streams = new ChatStreams();
  assert.equal(streams.delta(snapshot("a", "First")), "First");
  assert.equal(streams.delta(snapshot("b", "Second")), "Second");
  assert.equal(streams.delta(append("a", " run")), "First run");
  assert.equal(streams.delta(append("b", " run")), "Second run");
});

test("a run's baseline belongs to its session only", () => {
  const streams = new ChatStreams();
  streams.delta(snapshot("a", "Mine", "one"));
  assert.equal(streams.delta(append("a", " not yours", "two")), undefined);
  assert.equal(streams.delta(append("a", " still", "one")), "Mine still");
});

test("ending an older run keeps a newer run's baseline", () => {
  const streams = new ChatStreams();
  streams.delta(snapshot("old", "Old"));
  streams.delta(snapshot("new", "New"));
  streams.end("old");
  assert.equal(streams.delta(append("old", " late")), undefined);
  assert.equal(streams.delta(append("new", " text")), "New text");
});

test("clearing drops every baseline until the next snapshot", () => {
  const streams = new ChatStreams();
  streams.delta(snapshot("a", "Before"));
  streams.clear();
  assert.equal(streams.delta(append("a", " lost")), undefined);
  assert.equal(streams.delta(snapshot("a", "Before again")), "Before again");
});

test("a frame without text keeps the reply, a textless snapshot does not blank it", () => {
  assert.equal(nextChatText("Kept", { state: "delta" }), "Kept");
  assert.equal(nextChatText("Kept", { message: null, deltaText: "" }), "Kept");
  assert.equal(
    nextChatText("Kept", { message: { content: [{ type: "image" }] }, deltaText: "!" }),
    "Kept!",
  );
  assert.equal(nextChatText(undefined, { message: { content: "Plain" } }), "Plain");
  assert.equal(nextChatText("Old", { deltaText: "New", replace: true }), "New");
});

test("stored and returned text stays within the browser bound", () => {
  const streams = new ChatStreams();
  streams.delta(snapshot("a", "x".repeat(maxStreamText - 1)));
  assert.equal(streams.delta(append("a", "yz")).length, maxStreamText);
  assert.equal(streams.runs.get("a").text.length, maxStreamText);
});

test("runs whose end never arrives are forgotten oldest first", () => {
  const streams = new ChatStreams();
  for (let i = 0; i < 100; i++) streams.delta(snapshot(`run-${i}`, "x"));
  assert.ok(streams.runs.size <= 64);
  assert.equal(streams.delta(append("run-99", "y")), "xy");
  assert.equal(streams.delta(append("run-0", "y")), undefined);
});
