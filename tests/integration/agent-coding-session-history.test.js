import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";

// AGENTPIER-443: an agent's coding session start stays "running" by design
// (runtime-update-blockers.js); the action history learns from its session record
// whether the session still lives.
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function started(t) {
  const f = await agentSessionFixture(t);
  const changes = [];
  f.workflows.onChange = (ids) => changes.push(...ids);
  const { sessionId } = await f.call(await f.invocation(), {
    action: "start",
    requestId: crypto.randomUUID(),
    projectId: f.project.id,
    tool: "codex",
    worktree: false,
  });
  const listed = () =>
    f.workflows.list(f.id).actions.find((a) => a.payload.action === "session_start");
  return { f, sessionId, changes, listed };
}

test("a running session start names its session and says it is live", async (t) => {
  const { sessionId, listed } = await started(t);
  const action = listed();
  assert.equal(action.state, "running");
  assert.equal(action.sessionId, sessionId);
  assert.equal(action.sessionEnded, false);
});

test("a session start whose session the agent stopped reads as ended, live", async (t) => {
  const { f, sessionId, changes, listed } = await started(t);
  await f.call(await f.invocation(), { action: "stop", sessionId });
  await settle();
  changes.length = 0;
  await f.workflows.sessions.tick();
  await settle();
  assert.equal(listed().state, "running");
  assert.equal(listed().sessionEnded, true);
  // The action topic hears the end (live-topics.js agentActionsChanged).
  assert.ok(changes.includes(f.id));
});

test("a session start whose session record is gone reads as ended", async (t) => {
  const { f, sessionId, listed } = await started(t);
  f.workflows.sessions.store.delete(sessionId);
  assert.equal(listed().sessionEnded, true);
});

test("other actions carry no session state", async (t) => {
  const { f, listed } = await started(t);
  for (const a of f.workflows.list(f.id).actions)
    if (a !== listed() && a.payload.action !== "session_start")
      assert.equal("sessionEnded" in a, false);
});
