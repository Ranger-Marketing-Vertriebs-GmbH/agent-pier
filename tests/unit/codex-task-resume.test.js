import test from "node:test";
import assert from "node:assert/strict";
import { CodexTaskState } from "../../server/features/chat/codex-task-state.js";
import { codexTaskDriver } from "../../server/features/chat/codex-task-driver.js";

// A Codex child that was interrupted runs again when the main agent sends it input:
// Codex starts a new turn on the same thread. The proxy's `tasks` push names the
// active turn per thread, so a turn other than the interrupted one is a new run.
const CHILD = "00000000-0000-4000-8000-000000000001";
const session = { id: "s", tool: "codex", status: "running" };
const agent = { kind: "agent", id: CHILD, entry: { id: CHILD, status: "running" } };

function setup(turnId) {
  const state = new CodexTaskState();
  const report = (turn) =>
    state.report("s", {
      turns: turn ? [{ threadId: CHILD, turnId: turn }] : [],
      terminals: [],
      terminalMethods: true,
    });
  report(turnId);
  const commands = { connected: () => true, send: async () => ({ ok: true }) };
  return { driver: codexTaskDriver({ commands, state }), report };
}

test("a stop names the interrupted turn as the run it stopped", async () => {
  const { driver } = setup("turn-1");
  assert.deepEqual(await driver.stop(session, agent), { ok: true, run: "turn-1" });
});

test("only a turn other than the interrupted one is a new run", () => {
  const { driver, report } = setup("turn-1");
  const mark = { id: CHILD, kind: "agent", at: 1, run: "turn-1" };
  assert.equal(driver.resumed(session, agent, mark), false, "the stopped turn");
  report(null);
  assert.equal(driver.resumed(session, agent, mark), false, "no turn");
  report("turn-2");
  assert.equal(driver.resumed(session, agent, mark), true, "a new turn");
  // A stop without a known run never reads a turn as new; a task found ended does.
  assert.equal(driver.resumed(session, agent, { ...mark, run: undefined }), false);
  assert.equal(
    driver.resumed(session, agent, { id: CHILD, kind: "agent", at: 1, ended: true }),
    true,
  );
  const shell = { kind: "shell", id: `${CHILD}:1`, entry: {} };
  assert.equal(driver.resumed(session, shell, mark), false);
});
