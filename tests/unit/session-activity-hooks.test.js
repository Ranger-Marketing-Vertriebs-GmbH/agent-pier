import test from "node:test";
import assert from "node:assert/strict";
import { claudeHookActivity } from "../../server/features/sessions/native-session-activity.js";
import { mergeActivity } from "../../server/features/sessions/session-activity-merge.js";
import { codexActivityTracker } from "../../server/features/requests/codex-activity.js";
import { openCodeActivity } from "../../server/features/sessions/native-session-opencode.js";

test("Claude hook events map to activity, with background tasks as working", () => {
  const map = (payload) => claudeHookActivity(payload);
  assert.deepEqual(map({ hook_event_name: "SessionStart", source: "startup" }), {
    state: "idle",
    event: "SessionStart",
  });
  assert.equal(map({ hook_event_name: "SessionStart", source: "compact" }), null);
  assert.equal(map({ hook_event_name: "UserPromptSubmit" }).state, "working");
  assert.deepEqual(map({ hook_event_name: "Stop", background_tasks: [] }), {
    state: "idle",
    event: "Stop",
  });
  // Claude Code 2.1 reports a running background shell like this on Stop.
  assert.deepEqual(
    map({
      hook_event_name: "Stop",
      background_tasks: [
        { id: "b1", type: "shell", status: "running", command: "sleep 25" },
        { id: "b2", type: "agent", status: "completed" },
      ],
    }),
    { state: "working", event: "Stop", background: 1 },
  );
  assert.equal(map({ hook_event_name: "StopFailure", error: "x" }).state, "idle");
  assert.equal(map({ hook_event_name: "PermissionRequest" }).state, "waiting");
  assert.equal(map({ hook_event_name: "Elicitation" }).state, "waiting");
  assert.equal(
    map({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }).state,
    "waiting",
  );
  assert.equal(map({ hook_event_name: "PreToolUse", tool_name: "Bash" }), null);
  assert.equal(map({ hook_event_name: "SessionEnd", reason: "exit" }).state, "ended");
  assert.equal(map({ hook_event_name: "Notification" }), null);
  assert.equal(map(null), null);
});

test("merged activity prefers the report, and the terminal only where it contradicts it", () => {
  const now = 1_000_000;
  const merge = (pane, hook, extra = {}) =>
    mergeActivity({ pane, hook, now, paneChangedAt: now, ...extra });
  const hook = (state, extra = {}) => ({ state, event: "x", at: now - 1000, ...extra });
  assert.deepEqual(merge("unknown", hook("idle")), {
    state: "idle",
    source: "hook",
    event: "x",
  });
  // A narrow pane that hides the spinner no longer decides the state.
  assert.equal(merge("unknown", hook("working")).state, "working");
  assert.equal(merge("idle", hook("working")).source, "hook");
  assert.deepEqual(merge("working", null), {
    state: "working",
    source: "native-terminal",
  });
  assert.deepEqual(merge("idle", hook("ended")), {
    state: "idle",
    source: "native-terminal",
  });
  // AgentPier's open request and a native dialog on screen both mean waiting.
  assert.deepEqual(merge("idle", hook("working"), { pending: true }), {
    state: "waiting",
    source: "request",
  });
  assert.equal(merge("waiting", hook("idle")).state, "waiting");
  assert.deepEqual(merge("working", hook("idle")), {
    state: "working",
    source: "native-terminal",
  });
  // Esc sends no event: an idle composer that stopped changing ends the turn.
  const still = { paneChangedAt: now - 20_000 };
  const old = hook("working", { at: now - 20_000 });
  assert.deepEqual(merge("idle", old, still), {
    state: "idle",
    source: "native-terminal",
    ends: old.at,
  });
  // An ended report stays ended while the screen changes (typing, a resize) until
  // the CLI reports again.
  for (const pane of ["idle", "unknown"])
    assert.deepEqual(merge(pane, old, { endedAt: old.at }), {
      state: pane,
      source: "native-terminal",
    });
  assert.equal(
    merge("waiting", hook("waiting"), { endedAt: now - 1000 }).source,
    "native-terminal",
  );
  assert.equal(
    merge("unknown", hook("working", { at: now }), { endedAt: old.at }).state,
    "working",
  );
  assert.equal(merge("unknown", old, still).state, "working");
  assert.equal(merge("idle", { ...old, background: 2 }, still).background, 2);
  assert.equal(merge("idle", { ...old, background: 2 }, still).state, "working");
  // Without any progress for the stale window the report expires.
  const stale = { paneChangedAt: now - 11 * 60_000 };
  const ancient = hook("working", { at: now - 11 * 60_000, background: 1 });
  assert.deepEqual(merge("unknown", ancient, stale), {
    state: "unknown",
    source: "native-terminal",
    ends: ancient.at,
  });
  // A moving screen keeps a report fresh.
  assert.equal(merge("unknown", ancient).state, "working");
  // An answered dialog leaves no event; the terminal shows the turn moving on.
  assert.equal(merge("working", hook("waiting")).state, "working");
  assert.equal(merge("unknown", hook("waiting")).state, "waiting");
  assert.equal(merge("idle", hook("waiting", { at: now - 20_000 }), still).state, "idle");
  // A reported wait expires like any report when nothing moves on screen.
  assert.deepEqual(merge("unknown", hook("waiting", { at: now - 60 * 60_000 }), stale), {
    state: "unknown",
    source: "native-terminal",
    ends: now - 60 * 60_000,
  });
  // A dialog both on screen and reported stays the CLI's own wait.
  assert.deepEqual(merge("waiting", hook("waiting")), {
    state: "waiting",
    source: "hook",
    event: "x",
  });
  assert.equal(merge("waiting", hook("working")).source, "native-terminal");
});

test("Codex turns and thread status become one session activity", () => {
  const reports = [];
  const observe = codexActivityTracker(
    (value) => reports.push(value),
    () => 5,
  );
  observe({ method: "item/agentMessage/delta", params: { threadId: "a" } });
  observe({ method: "turn/started", params: { threadId: "a", turn: { id: "t1" } } });
  observe({
    method: "thread/status/changed",
    params: { threadId: "a", status: { type: "active", activeFlags: [] } },
  });
  observe({ method: "turn/started", params: { threadId: "b", turn: { id: "t2" } } });
  observe({
    method: "thread/status/changed",
    params: {
      threadId: "b",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    },
  });
  observe({
    method: "thread/status/changed",
    params: { threadId: "b", status: { type: "active", activeFlags: [] } },
  });
  observe({
    method: "turn/completed",
    params: { threadId: "b", turn: { id: "t2", status: "completed" } },
  });
  observe({
    method: "turn/completed",
    params: { threadId: "a", turn: { id: "t1", status: "interrupted" } },
  });
  assert.deepEqual(
    reports.map(({ state, event }) => [state, event]),
    [
      ["working", "turn/started"],
      ["waiting", "thread/status/changed"],
      ["working", "thread/status/changed"],
      ["idle", "turn/completed"],
    ],
  );
  assert.equal(reports[0].at, 5);
  const failing = codexActivityTracker(() => {
    throw Error("disk full");
  });
  assert.doesNotThrow(() =>
    failing({ method: "turn/started", params: { threadId: "a" } }),
  );
});

test("OpenCode reports its visible session's busy state and pending dialogs", () => {
  const data = { status: { type: "idle" }, permission: [], question: [] };
  const api = {
    state: {
      session: {
        status: () => data.status,
        permission: () => data.permission,
        question: () => data.question,
      },
    },
  };
  assert.equal(openCodeActivity(api, null), null);
  assert.equal(openCodeActivity({ state: {} }, "s"), null);
  assert.equal(openCodeActivity(api, "s"), "idle");
  data.status = { type: "busy" };
  assert.equal(openCodeActivity(api, "s"), "working");
  data.status = { type: "retry", attempt: 2 };
  assert.equal(openCodeActivity(api, "s"), "working");
  data.question = [{ id: "q" }];
  assert.equal(openCodeActivity(api, "s"), "waiting");
  data.question = [];
  data.status = undefined;
  assert.equal(openCodeActivity(api, "s"), "idle");
});
