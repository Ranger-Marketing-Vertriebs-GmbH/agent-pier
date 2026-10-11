import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-action-counts-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const assistant = (name) =>
    store.createAssistant({ name, model: { connectionId: "c", modelId: "m" } });
  const actions = new AssistantActionStore(store.db);
  let n = 0;
  const reserve = (assistantId, values) =>
    actions.reserve({
      assistantId,
      key: `action-${n++}`,
      payload: { action: "memory_write", content: `entry ${n}` },
      origin: { kind: "owner" },
      ...values,
    });
  return { assistant, actions, reserve };
}

test("awaiting approvals are counted per agent, split into own and team requests", (t) => {
  const { assistant, actions, reserve } = setup(t);
  const home = assistant("Home"),
    other = assistant("Other");
  reserve(home.id, { state: "awaiting_approval" });
  reserve(home.id, { state: "awaiting_approval" });
  reserve(home.id, { state: "awaiting_approval", teamId: "team-1" });
  reserve(home.id, { state: "completed" });
  reserve(other.id, { state: "declined" });

  assert.deepEqual(actions.awaitingCounts(0), { [home.id]: { own: 2, team: 1 } });
});

test("expired approvals no longer count", (t) => {
  const { assistant, actions, reserve } = setup(t);
  const home = assistant("Home");
  const action = reserve(home.id, { state: "awaiting_approval" });

  assert.deepEqual(actions.awaitingCounts(action.expiresAt - 1), {
    [home.id]: { own: 1, team: 0 },
  });
  assert.deepEqual(actions.awaitingCounts(action.expiresAt), {});
});
