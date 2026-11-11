import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { stripPrivateRows } from "../../server/features/operations/private-tables.js";
import { AgentGroups } from "../../server/features/assistants/agent-groups.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-groups-"));
  const store = new AssistantStore({ dataDir });
  const groups = new AgentGroups(store);
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  return { store, groups, agent, dataDir };
}

test("areas persist order and exclusive memberships without modifying agent settings", (t) => {
  const { store, groups, agent, dataDir } = fixture(t);
  const a = groups.create("  Development  "),
    b = groups.create("Personal");
  groups.assign(agent.id, { groupId: a.id, previousGroupId: null });
  groups.assign(agent.id, { groupId: b.id, previousGroupId: a.id });
  assert.deepEqual(
    groups.list().map((g) => g.assistantIds),
    [[], [agent.id]],
  );
  assert.deepEqual(store.getAssistant(agent.id), agent);
  groups.reorder(b.id, { direction: "up", revision: b.revision });
  assert.deepEqual(
    groups.list().map((g) => g.id),
    [b.id, a.id],
  );
  const reopened = new AssistantStore({ dataDir });
  t.after(() => reopened.close());
  const other = new AgentGroups(reopened);
  assert.deepEqual(other.list(), groups.list());
  const renamed = other.rename(b.id, { name: "Private", revision: 2 });
  assert.equal(groups.get(b.id).name, "Private");
  assert.throws(() => groups.rename(b.id, { name: "Stale", revision: 2 }), {
    status: 409,
  });
  assert.throws(() => groups.remove(b.id, { revision: 2 }), { status: 409 });
  groups.remove(b.id, { revision: renamed.revision });
  assert.equal(groups.of(agent.id), null);
  assert.deepEqual(store.getAssistant(agent.id), agent);
});

test("areas reject invalid names, unknown groups and stale moves without losing membership", (t) => {
  const { groups, agent } = fixture(t);
  for (const name of [null, " ", "x".repeat(61), "bad\0name"])
    assert.throws(() => groups.create(name), { status: 400 });
  const a = groups.create("Development");
  assert.throws(() => groups.create("development"), { status: 409 });
  groups.assign(agent.id, { groupId: a.id, previousGroupId: null });
  assert.throws(() => groups.assign(agent.id, { groupId: null, previousGroupId: null }), {
    status: 409,
  });
  assert.throws(
    () => groups.assign(agent.id, { groupId: "gone", previousGroupId: a.id }),
    { status: 404 },
  );
  assert.equal(groups.of(agent.id), a.id);
  groups.assign(agent.id, { groupId: null, previousGroupId: a.id });
  assert.equal(groups.of(agent.id), null);
});

test("members cannot move independently; archive retains membership and deletion cleans it", (t) => {
  const { store, groups, agent } = fixture(t);
  const group = groups.create("Work");
  const child = store.reserveMember({
    id: "child",
    parent: agent.id,
    assignment: { name: "Member", role: "Review", task: "Check" },
    snapshot: agent,
    teamId: "team",
    lifetime: "permanent",
  });
  groups.assign(agent.id, { groupId: group.id, previousGroupId: null });
  assert.throws(
    () => groups.assign(child.id, { groupId: group.id, previousGroupId: null }),
    { status: 409 },
  );
  const archived = store.setArchived(agent.id, agent.revision, "2026-01-01");
  assert.equal(groups.of(agent.id), group.id);
  assert.throws(
    () => groups.assign(agent.id, { groupId: null, previousGroupId: group.id }),
    { status: 409 },
  );
  store.setArchived(agent.id, archived.revision, null);
  assert.equal(groups.of(agent.id), group.id);
  store.db.prepare("DELETE FROM assistants WHERE id=?").run(agent.id);
  assert.deepEqual(groups.list()[0].assistantIds, []);
  assert.equal(store.getAssistant(child.id).parentAssistantId, agent.id);
});

test("configuration backups retain areas and root assignments", (t) => {
  const { store, groups, agent } = fixture(t);
  const group = groups.create("Work");
  groups.assign(agent.id, { groupId: group.id, previousGroupId: null });
  store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "agent:home:private",
  });
  stripPrivateRows(store.db);
  assert.equal(store.listConversations().length, 0);
  assert.deepEqual(groups.list()[0].assistantIds, [agent.id]);
});
