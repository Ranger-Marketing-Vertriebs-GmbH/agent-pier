import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { register } from "../../server/features/claude-mod/bridge-mod.js";
import { ClaudeModBridge } from "../../server/features/claude-mod/claude-mod-bridge.js";
import { claudeModEvents } from "../../server/features/claude-mod/claude-mod-events.js";
import { ReplyStreams } from "../../server/features/chat/reply-streams.js";
import { nextReplies, visibleReplies } from "../../web/features/chat/reply-stream.js";
import {
  liveActivity,
  liveToolName,
  liveValue,
} from "../../web/features/chat/live-status.js";
import { fakeModRuntime } from "../helpers/fake-mod-runtime.js";

const TOKEN = "a".repeat(64);
const env = {
  AGENTPIER_CLAUDE_BRIDGE_SOCKET: "/tmp/agentpier-requests-1-x/claude-mod.sock",
  AGENTPIER_REQUEST_FILE: "/data/requests/session-1.launch.json",
  AGENTPIER_REQUEST_TOKEN: TOKEN,
};
const TURN = "0c9e6a2f-7d41-4f4e-9a15-3f4f7c2b8d10";
const ID = "toolu_01ABCdef";

test("the mod reports a tool call the moment the model begins it, never its input", async () => {
  const runtime = fakeModRuntime({ env });
  register(runtime.on);
  await runtime.dispatch("session.start", {});
  await runtime.tick();
  await runtime.dispatch("turn.start", { turnId: TURN, text: "" });
  const chunks = [
    { kind: "text", index: 0, text: "Let me look.", ref: 1 },
    { kind: "tool", index: 1, id: ID, name: "Agent", ref: 2 },
    { kind: "input", index: 1, json: '{"prompt":"secret plan', ref: 3 },
    { kind: "input", index: 1, json: '"}', ref: 4 },
    // A chunk of an unknown shape is passed on and not reported.
    { kind: "tool", index: 2, ref: 5 },
  ];
  const step = await runtime.stream("turn.step", { turnId: TURN, index: 2 }, chunks);
  assert.deepEqual(step.chunks, chunks, "the TUI sees every chunk unchanged");
  await runtime.tick();
  assert.deepEqual(runtime.events().slice(1), [
    { type: "turn.start", turn: TURN },
    {
      type: "text",
      turn: TURN,
      step: 2,
      block: 0,
      order: 0,
      from: 0,
      text: "Let me look.",
    },
    { type: "tool.prepare", turn: TURN, step: 2, block: 1, id: ID, name: "Agent" },
  ]);
  const wire = JSON.stringify(runtime.requests.map((request) => request.body));
  assert.doesNotMatch(wire, /secret plan|"input"|json/);
});

test("a subagent's tool calls are not reported", async () => {
  const runtime = fakeModRuntime({ env });
  register(runtime.on);
  await runtime.dispatch("session.start", {});
  await runtime.dispatch("turn.start", { turnId: TURN, text: "" });
  await runtime.stream("turn.step", { turnId: TURN, index: 0, agentId: "a1" }, [
    { kind: "tool", index: 0, id: ID, name: "Bash", ref: 1 },
  ]);
  await runtime.tick();
  assert.ok(!runtime.events().some((event) => event.type === "tool.prepare"));
});

test("the server validates tool.prepare, and an older server skips it", () => {
  const event = { type: "tool.prepare", turn: TURN, step: 0, block: 1, id: ID };
  assert.deepEqual(
    claudeModEvents({ protocol: 1, events: [{ ...event, name: "Bash" }] }),
    [{ ...event, name: "Bash" }],
  );
  for (const bad of [
    { ...event, name: "Bash\n" },
    { ...event, name: "Bash", id: "../x" },
    { ...event, name: "Bash", block: -1 },
    { ...event, name: "Bash", input: undefined, step: "0" },
  ])
    assert.throws(() => claudeModEvents({ protocol: 1, events: [bad] }));
  // An unknown report (what a server without this change does with it) is skipped.
  assert.deepEqual(
    claudeModEvents({ protocol: 1, events: [{ type: "tool.later", id: ID }] }),
    [],
  );
});

function bridge(t) {
  const frames = [];
  const replies = new ReplyStreams({ flushMs: 1 });
  t.after(() => replies.close());
  replies.subscribe("s", (frame) => frames.push(frame));
  const touched = [];
  const mod = new ClaudeModBridge({
    streams: {
      streamText: (...args) => replies.streamText(...args),
      endStream: (...args) => {
        touched.push(args[1] || "turn");
        replies.endStream(...args);
      },
      setStatus: (...args) => replies.setStatus(...args),
    },
    drafts: { end: () => {} },
  });
  return {
    mod,
    frames,
    touched,
    replies,
    status: () => frames.filter((frame) => frame.type === "live-status").at(-1)?.status,
    runs: () =>
      frames.reduce((value, frame) => nextReplies(value, frame) || value, new Map()),
  };
}
const text = (step, block, order, from, value) => ({
  type: "text",
  turn: TURN,
  step,
  block,
  order,
  from,
  text: value,
});
const prepare = (step, block, name = "Agent", id = ID) => ({
  type: "tool.prepare",
  turn: TURN,
  step,
  block,
  id,
  name,
});
const start = { type: "turn.start", turn: TURN };

test("preparing shows until the tool starts", (t) => {
  const b = bridge(t);
  b.mod.receive("s", [start, prepare(0, 0)]);
  assert.equal(b.status().preparing, "Agent");
  assert.equal(b.status().state, "working");
  // Another call's start does not end this one's preparation.
  b.mod.receive("s", [{ type: "tool.start", id: "toolu_other", name: "Read" }]);
  assert.equal(b.status().preparing, "Agent");
  b.mod.receive("s", [{ type: "tool.start", id: ID, name: "Agent" }]);
  assert.equal(b.status().preparing, undefined);
  assert.equal(b.status().tool, "Agent");
});

test("preparing gives way to text, thinking, compaction, the turn's end and an interrupt", (t) => {
  for (const [label, events] of [
    ["text", [text(1, 0, 1, 0, "Done.")]],
    ["thinking", [{ type: "phase", turn: TURN, phase: "thinking" }]],
    ["compaction", [{ type: "compact.start" }]],
    ["turn end", [{ type: "turn.complete", turn: TURN, aborted: false }]],
    ["interrupt", [{ type: "turn.complete", turn: TURN, aborted: true }]],
    ["next turn", [{ type: "turn.start", turn: "turn-2" }]],
  ]) {
    const b = bridge(t);
    b.mod.receive("s", [start, prepare(0, 0, "mcp__plane__search")]);
    assert.equal(b.status().preparing, "mcp__plane__search", label);
    b.mod.receive("s", events);
    assert.equal(b.status().preparing, undefined, label);
  }
});

test("a tool call ends the turn's text before it, once, without losing a delta", async (t) => {
  const b = bridge(t);
  b.mod.receive("s", [
    start,
    text(0, 0, 0, 0, "First "),
    text(0, 0, 0, 6, "step."),
    prepare(0, 1, "Read", "toolu_a"),
    { type: "tool.start", id: "toolu_a", name: "Read" },
    { type: "tool.end", id: "toolu_a" },
    text(1, 0, 1, 0, "Now "),
  ]);
  // Text before the tool block of a later step, and that step's own text.
  b.mod.receive("s", [text(1, 0, 1, 4, "the plan."), prepare(1, 1)]);
  await delay(5);
  assert.deepEqual(b.touched, [
    "claude-mod-" + TURN + "-0-0",
    "claude-mod-" + TURN + "-1-0",
  ]);
  const runs = b.runs();
  assert.deepEqual(
    [...runs.values()].map((run) => [run.text, run.ended === true]),
    [
      ["First step.", true],
      ["Now the plan.", true],
    ],
    "every delta reached the browser before its end",
  );
  assert.deepEqual(b.replies.runs("s"), {}, "nothing is held for the turn's end");
  // A resend of an ended run (a failed request) stays out and needs no resync.
  assert.deepEqual(b.mod.receive("s", [text(0, 0, 0, 0, "First step.")]), {});
  assert.deepEqual(b.replies.runs("s"), {});
  assert.equal(b.status().preparing, "Agent", "a resend does not end the preparation");
  // The text block after the tool call streams as usual and ends with the turn.
  b.mod.receive("s", [
    text(2, 0, 2, 0, "Result."),
    { type: "turn.complete", turn: TURN, aborted: false },
  ]);
  await delay(5);
  assert.equal(b.runs().get(`claude-mod-${TURN}-2-0`).ended, true);
});

test("an ended run stays until the transcript holds it, then the transcript shows it once", () => {
  const runs = new Map([
    ["r1", { runId: "r1", text: "First step.", turn: TURN, order: 0, ended: true }],
  ]);
  const prompt = { id: "u", role: "user", text: "Go" };
  assert.equal(visibleReplies(runs, { messages: [prompt] }).length, 1);
  assert.equal(
    visibleReplies(runs, {
      messages: [prompt, { id: "m", role: "assistant", text: "First step." }],
    }).length,
    0,
  );
});

test("the header ranks preparing after compacting and before a running tool", () => {
  const frame = (status) => liveValue({ status: { state: "working", at: 2, ...status } });
  const activity = { state: "working", label: "Working", observedAt: "" };
  const detail = (status) => liveActivity(activity, frame(status)).detail;
  assert.equal(frame({ preparing: "Agent" }).preparing, "Agent");
  assert.equal(frame({ preparing: 3 }).preparing, "");
  assert.equal(detail({ preparing: "Agent", tool: "Bash" }), "Bereitet Agent vor");
  assert.equal(
    detail({ preparing: "Agent", phase: "compacting" }),
    "Komprimiert die Unterhaltung",
  );
  assert.equal(detail({ preparing: "mcp__plane__search" }), "Bereitet plane__search vor");
  assert.equal(detail({ tool: "Bash" }), "Führt Bash aus");
  assert.equal(liveToolName("mcp__x__y"), "x__y");
  assert.equal(liveToolName("Edit"), "Edit");
});
