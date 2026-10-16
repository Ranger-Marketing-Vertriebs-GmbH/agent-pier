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

// A member's shell request in a turn its lead delegated waits in both chats.
test("a delegated request counts for the member and its lead", (t) => {
  const { assistant, actions, reserve } = setup(t);
  const lead = assistant("Lead"),
    member = assistant("Member");
  const waiting = reserve(member.id, {
    state: "awaiting_approval",
    leadAssistantId: lead.id,
  });
  reserve(member.id, { state: "completed", leadAssistantId: lead.id });

  assert.deepEqual(actions.awaitingCounts(0), {
    [member.id]: { own: 1, team: 0 },
    [lead.id]: { own: 0, team: 1 },
  });
  assert.deepEqual(
    actions.delegated(lead.id).map((a) => a.id),
    [waiting.id],
  );
  assert.deepEqual(actions.delegated(member.id), []);
});

// An allowed SSH command stays in the lead's chat while it runs, as in the member's.
test("a delegated SSH command stays listed for its lead while it runs", (t) => {
  const { assistant, actions, reserve } = setup(t);
  const lead = assistant("Lead"),
    member = assistant("Member");
  const ssh = (state) =>
    reserve(member.id, {
      state,
      leadAssistantId: lead.id,
      payload: { action: "ssh", command: "uptime" },
    });
  const running = ssh("executing");
  ssh("completed");
  reserve(member.id, { state: "executing", leadAssistantId: lead.id });

  assert.deepEqual(
    actions.delegated(lead.id).map((a) => a.id),
    [running.id],
  );
  assert.deepEqual(actions.awaitingCounts(0), {});
});
