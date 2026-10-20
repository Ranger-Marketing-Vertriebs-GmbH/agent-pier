import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  ClaudeModBridge,
  preferModActivity,
} from "../../server/features/claude-mod/claude-mod-bridge.js";
import { claudeModEvents } from "../../server/features/claude-mod/claude-mod-events.js";
import { ReplyStreams } from "../../server/features/chat/reply-streams.js";
import { mergeActivity } from "../../server/features/sessions/session-activity-merge.js";
import { nextReplies } from "../../web/features/chat/reply-stream.js";
import { liveActivity, liveValue } from "../../web/features/chat/live-status.js";

const TURN = "0c9e6a2f-7d41-4f4e-9a15-3f4f7c2b8d10";

function bridge(t) {
  const frames = [];
  const replies = new ReplyStreams({ flushMs: 1 });
  t.after(() => replies.close());
  replies.subscribe("s", (frame) => frames.push(frame));
  const streams = {
    streamText: (...args) => replies.streamText(...args),
    endStream: (...args) => replies.endStream(...args),
    setStatus: (...args) => replies.setStatus(...args),
  };
  const ended = [];
  const activity = [];
  let now = 1000;
  const mod = new ClaudeModBridge({
    streams,
    drafts: { end: (id) => ended.push(id) },
    onActivity: (id) => activity.push(id),
    now: () => now,
  });
  return {
    mod,
    frames,
    ended,
    activity,
    tick: (ms) => (now += ms),
    runs: () =>
      frames.reduce((value, frame) => nextReplies(value, frame) || value, new Map()),
    status: () => frames.filter((frame) => frame.type === "live-status").at(-1)?.status,
  };
}
const text = (from, value, extra = {}) => ({
  type: "text",
  turn: TURN,
  step: 0,
  block: 0,
  order: 0,
  from,
  text: value,
  ...extra,
});

test("mod reports are validated as a batch; unknown report types are skipped", () => {
  const events = claudeModEvents({
    protocol: 1,
    events: [
      { type: "hello", cli: "2.1.304", extra: "dropped" },
      text(0, "Hi"),
      { type: "tool.start", id: "toolu_1", name: "mcp__github__search" },
      {
        type: "turn.complete",
        turn: TURN,
        aborted: false,
        durationMs: 5,
        usage: { input: 1, output: 2 },
      },
      { type: "future.event" },
    ],
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ["hello", "text", "tool.start", "turn.complete"],
  );
  assert.deepEqual(events[0], { type: "hello", cli: "2.1.304" });
  for (const bad of [
    { protocol: 2, events: [] },
    { protocol: 1, events: [text(-1, "x")] },
    { protocol: 1, events: [text(0, "x", { turn: "../x" })] },
    { protocol: 1, events: [text(65536, "x")] },
    { protocol: 1, events: [{ type: "tool.start", id: "t", name: "a\nb" }] },
    { protocol: 1, events: [{ type: "phase", turn: TURN, phase: "secret" }] },
    { protocol: 1, events: [{ type: "Bad Type" }] },
    { protocol: 1, events: Array.from({ length: 257 }, () => ({ type: "hello" })) },
  ])
    assert.throws(() => claudeModEvents(bad), /Invalid Claude mod/);
});

test("mod text streams token by token into the turn's labelled runs", async (t) => {
  const b = bridge(t);
  b.mod.receive("s", [{ type: "hello" }, { type: "turn.start", turn: TURN }]);
  assert.deepEqual(b.ended, ["s"], "MessageDisplay drafts give way");
  assert.equal(b.mod.active("s"), true);
  b.mod.receive("s", [text(0, "Hel")]);
  b.mod.receive("s", [text(3, "lo")]);
  b.mod.receive("s", [text(0, "Next", { step: 1, order: 1 })]);
  await delay(10);
  const runs = [...b.runs().values()];
  assert.deepEqual(
    runs.map((run) => [run.text, run.turn, run.order]),
    [
      ["Hello", TURN, 0],
      ["Next", TURN, 1],
    ],
  );
  // An offset that no longer fits (the server restarted) asks the mod for whole runs.
  assert.deepEqual(b.mod.receive("s", [text(99, "x", { block: 5 })]), { resync: true });
});

test("the live status follows turns, thinking, tools, subagents and compaction", (t) => {
  const b = bridge(t);
  b.mod.receive("s", [{ type: "hello" }]);
  assert.equal(b.status().state, "idle");
  b.mod.receive("s", [
    { type: "turn.start", turn: TURN },
    { type: "phase", turn: TURN, phase: "thinking" },
  ]);
  assert.deepEqual(b.status(), { state: "working", phase: "thinking", at: 1000 });
  b.mod.receive("s", [{ type: "tool.start", id: "toolu_1", name: "Bash" }]);
  assert.equal(b.status().tool, "Bash");
  assert.equal(b.status().phase, undefined, "a tool call ends the thinking");
  b.mod.receive("s", [
    { type: "agent.start", id: "a1", kind: "Explore" },
    { type: "tool.end", id: "toolu_1" },
  ]);
  assert.deepEqual(b.status(), {
    state: "working",
    agents: 1,
    at: 1000,
  });
  b.mod.receive("s", [text(0, "x"), { type: "compact.start" }]);
  assert.equal(b.status().phase, "compacting");
  b.mod.receive("s", [
    { type: "compact.end" },
    { type: "turn.complete", turn: TURN, aborted: true },
  ]);
  assert.deepEqual(b.status(), { state: "idle", agents: 1, at: 1000 });
  assert.deepEqual(b.activity, ["s"], "the chat reads its transcript at the turn's end");
  assert.equal(b.frames.filter((f) => f.type === "stream-end").length, 1);
});

test("the mod's activity decides, except for dialogs and background tasks the hooks saw", (t) => {
  const b = bridge(t);
  assert.equal(b.mod.activity("s"), null);
  b.mod.receive("s", [{ type: "turn.start", turn: TURN }]);
  const working = b.mod.activity("s");
  assert.deepEqual(working, {
    state: "working",
    event: "mod",
    at: 1000,
    mod: true,
    turnAt: 1000,
  });
  const stop = { state: "idle", event: "Stop", at: 900 };
  assert.equal(preferModActivity(working, stop), working);
  assert.equal(preferModActivity(null, stop), stop);
  const dialog = { state: "waiting", event: "PermissionRequest", at: 1001 };
  assert.equal(preferModActivity(working, dialog), dialog);
  assert.equal(preferModActivity(working, { ...dialog, at: 999 }), working);
  b.tick(50);
  b.mod.receive("s", [{ type: "turn.complete", turn: TURN, aborted: false }]);
  const idle = b.mod.activity("s");
  const background = { state: "working", event: "Stop", background: 2, at: 1060 };
  assert.equal(preferModActivity(idle, background), background);
  assert.equal(
    preferModActivity(idle, { ...background, at: 10 }),
    idle,
    "an older turn's",
  );
  // An idle composer with a still screen does not end a mod turn; staleness does.
  const now = 1000 + 60000;
  assert.equal(mergeActivity({ pane: "idle", hook: working, now }).source, "mod");
  assert.equal(mergeActivity({ pane: "idle", hook: working, now }).state, "working");
  assert.equal(
    mergeActivity({ pane: "idle", hook: working, now: 1000 + 11 * 60000 }).source,
    "native-terminal",
  );
  b.mod.forget("s");
  assert.equal(b.mod.active("s"), false);
  // `/compact` outside a turn is work too.
  b.mod.receive("s", [{ type: "compact.start" }]);
  assert.equal(b.mod.activity("s").state, "working");
  assert.equal(b.status().phase, "compacting");
  b.mod.receive("s", [{ type: "compact.end" }]);
  assert.equal(b.mod.activity("s").state, "idle");
  b.mod.forget("s");
  assert.equal(b.status(), null);
});

test("the header takes the newer of the live and the polled activity", () => {
  const live = liveValue({
    status: { state: "working", tool: "mcp__github__search", agents: 2, at: 2000 },
  });
  const polled = {
    state: "idle",
    label: "Ready",
    observedAt: new Date(1000).toISOString(),
  };
  const shown = liveActivity(polled, live);
  assert.equal(shown.state, "working");
  assert.equal(shown.label, "Arbeitet");
  assert.match(shown.detail, /github__search/);
  assert.equal(
    liveActivity({ ...polled, observedAt: new Date(3000).toISOString() }, live).state,
    "idle",
  );
  assert.equal(liveActivity({ ...polled, state: "waiting" }, live).state, "waiting");
  assert.equal(liveActivity(polled, null).detail, "");
  assert.equal(liveValue({ status: { state: "bogus" } }), null);
  const thinking = liveValue({ status: { state: "working", phase: "thinking", at: 5 } });
  assert.equal(
    liveActivity({ state: "idle", label: "Ready" }, thinking).detail,
    "Denkt nach",
  );
});
