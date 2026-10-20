import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ReplyStreams } from "../../server/features/chat/reply-streams.js";
import {
  nextReplies,
  visibleReplies,
  withoutEnded,
} from "../../web/features/chat/reply-stream.js";

function streams(t, options = {}) {
  const ended = [];
  const value = new ReplyStreams({
    flushMs: 1,
    onEnd: (id) => ended.push(id),
    ...options,
  });
  t.after(() => value.close());
  return { value, ended };
}
const flushed = () => delay(10);

test("each subscriber gets its own offsets; a new one gets the whole text", async (t) => {
  const { value } = streams(t);
  const a = [];
  value.subscribe("s", (frame) => a.push(frame));
  value.streamText("s", "r", { text: "Hel", turn: "t1" });
  await flushed();
  value.streamText("s", "r", { text: "lo", from: 3 });
  await flushed();
  assert.deepEqual(
    a.map(({ from, text }) => [from, text]),
    [
      [0, "Hel"],
      [3, "lo"],
    ],
  );
  assert.equal(a[0].turn, "t1");
  const b = [];
  value.subscribe("s", (frame) => b.push(frame));
  assert.deepEqual(
    b.map(({ from, text }) => [from, text]),
    [[0, "Hello"]],
  );
  // No sequence number: offsets alone order the text.
  assert.equal("sequence" in b[0], false);
});

test("an append that does not continue the held text is refused", (t) => {
  const { value } = streams(t);
  assert.equal(value.streamText("s", "r", { text: "abc", from: 2 }), false, "no run");
  value.streamText("s", "r", { text: "abc" });
  assert.equal(value.streamText("s", "r", { text: "x", from: 5 }), false, "gap");
  assert.equal(value.runs("s").r.text, "abc");
});

test("a rewrite sends the whole text again", async (t) => {
  const { value } = streams(t);
  const frames = [];
  value.subscribe("s", (frame) => frames.push(frame));
  value.streamText("s", "r", { text: "first" });
  await flushed();
  value.streamText("s", "r", { text: "other" });
  await flushed();
  assert.deepEqual(
    frames.map(({ from, text }) => [from, text]),
    [
      [0, "first"],
      [0, "other"],
    ],
  );
});

test("token-sized appends are coalesced", async (t) => {
  const { value } = streams(t, { flushMs: 30 });
  const frames = [];
  value.subscribe("s", (frame) => frames.push(frame));
  let text = "";
  for (const part of ["a", "b", "c", "d"]) {
    value.streamText("s", "r", { text: part, from: text.length });
    text += part;
  }
  await delay(60);
  assert.deepEqual(
    frames.map(({ text }) => text),
    ["abcd"],
  );
});

test("text and runs are capped", async (t) => {
  const { value } = streams(t, { maxText: 10, maxRuns: 2 });
  value.streamText("s", "r", { text: "0123456789abc" });
  assert.equal(value.runs("s").r.text, "0123456789");
  // Appends past the cap keep the first part.
  assert.equal(value.streamText("s", "r", { text: "more", from: 13 }), true);
  assert.equal(value.runs("s").r.text, "0123456789");
  value.streamText("s", "r2", { text: "x" });
  value.streamText("s", "r3", { text: "y" });
  assert.deepEqual(Object.keys(value.runs("s")), ["r2", "r3"], "oldest forgotten");
});

test("an ended run, or every run of an ended turn, is dropped and announced", async (t) => {
  const { value, ended } = streams(t);
  const frames = [];
  value.subscribe("s", (frame) => frames.push(frame));
  value.streamText("s", "a", { text: "A", turn: "t1" });
  value.streamText("s", "b", { text: "B", turn: "t1" });
  value.streamText("s", "c", { text: "C", turn: "t2" });
  await flushed();
  value.endStream("s", "a");
  value.endStream("s", undefined, { turn: "t1" });
  assert.deepEqual(Object.keys(value.runs("s")), ["c"]);
  assert.deepEqual(
    frames.filter((f) => f.type === "stream-end").map((f) => f.runId),
    ["a", "b"],
  );
  assert.deepEqual(ended, ["s", "s"], "the chat reads its transcript again");
  value.endStream("s");
  assert.deepEqual(value.runs("s"), {});
  assert.equal(value.sessions.has("s"), true, "kept while subscribed");
});

test("a run that goes quiet expires and nothing is kept without viewers", async (t) => {
  const { value } = streams(t, { idleMs: 30 });
  value.streamText("s", "r", { text: "stuck" });
  await delay(80);
  assert.deepEqual(value.runs("s"), {});
  assert.equal(value.sessions.size, 0);
});

test("the browser folds frames by offset and refuses a gap", () => {
  let runs = new Map();
  runs = nextReplies(runs, { type: "stream", runId: "r", from: 0, text: "Hi", order: 0 });
  runs = nextReplies(runs, { type: "stream", runId: "r", from: 2, text: " there" });
  assert.equal(runs.get("r").text, "Hi there");
  assert.equal(
    nextReplies(runs, { type: "stream", runId: "r", from: 3, text: "x" }),
    null,
  );
  assert.equal(
    nextReplies(runs, { type: "stream", runId: "x", from: 1, text: "x" }),
    null,
  );
  runs = nextReplies(runs, { type: "stream-end", runId: "r" });
  assert.equal(runs.get("r").ended, true);
  assert.equal(withoutEnded(runs).size, 0);
});

test("a live reply gives way to its transcript message by id, order or text", () => {
  const runs = (list) => new Map(list.map((run) => [run.runId, run]));
  const history = (...rows) => ({ providerSessionId: "main", messages: rows });
  const user = { id: "u", role: "user", text: "Q" };
  // Codex items and OpenCode parts keep their id in the history.
  assert.deepEqual(
    visibleReplies(
      runs([{ runId: "item", text: "Hello" }]),
      history(user, { id: "item", role: "assistant", text: "Hello!" }),
    ),
    [],
  );
  // Claude: two messages in one turn, the first is in the transcript already.
  const claude = runs([
    { runId: "m2", text: "Second", turn: "t", order: 1 },
    { runId: "m1", text: "First draft", turn: "t", order: 0 },
  ]);
  const old = { id: "old", role: "assistant", text: "Earlier turn" };
  assert.deepEqual(
    visibleReplies(claude, history(old, user)).map((run) => run.runId),
    ["m1", "m2"],
    "in reply order",
  );
  assert.deepEqual(
    visibleReplies(
      claude,
      history(old, user, { id: "j1", role: "assistant", text: "First (final)" }),
    ).map((run) => run.runId),
    ["m2"],
  );
  // A reply of the current turn that starts with the streamed text replaces it.
  assert.deepEqual(
    visibleReplies(
      runs([{ runId: "p", text: "Partial" }]),
      history(user, { id: "z", role: "assistant", text: "Partial and done" }),
    ),
    [],
  );
  // Another conversation's thread (a sub-agent) never shows.
  assert.deepEqual(
    visibleReplies(runs([{ runId: "s", text: "Sub", thread: "child" }]), history(user)),
    [],
  );
});
