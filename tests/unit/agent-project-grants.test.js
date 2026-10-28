import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import {
  AssistantAccess,
  approvalRevision,
} from "../../server/features/assistants/assistant-access.js";
import { AgentProjectStore } from "../../server/features/assistants/agent-project-store.js";
import {
  grantCreatedProject,
  setCreatedProjectCoding,
} from "../../server/features/assistants/agent-project-grants.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

const model = { connectionId: "c", modelId: "m" };

// A real access policy on a disposable assistant store, set up like the SSH grant
// tests: revision 4 with an older approval revision and every other grant set.
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-agent-projects-"));
  const store = new AssistantStore({ dataDir });
  let changed = 0;
  const access = new AssistantAccess({
    assistants: { store, changed: () => changed++ },
  });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { id } = store.createAssistant({ name: "Lead", instructions: "Plan", model });
  access.write(id, {
    ...access.stored(id),
    revision: 4,
    approvalRevision: 3,
    projectIds: ["p-b", "p-old"],
    projectFiles: { "p-b": "read" },
    sessionProjectIds: ["p-b"],
    pipelineIds: ["pipeline"],
    definitions: { pipeline: "hash-1" },
    sshAccesses: [{ accessId: "host-1", mode: "approval" }],
    mailAccesses: [{ accountId: "mail-1", mode: "read" }],
    github: { credentialId: "gh-1", level: "read" },
    secretIds: ["secret-1"],
    memoryWrite: true,
  });
  return { store, access, id, changed: () => changed };
}

test("granting a created project writes only its fields and keeps the approval revision", (t) => {
  const { access, id, changed } = fixture(t);
  const before = access.stored(id);
  const after = grantCreatedProject(access, id, "p-new", { coding: true });
  assert.deepEqual(after, access.stored(id), "the returned policy is the stored one");
  assert.deepEqual(after.projectIds, ["p-b", "p-new", "p-old"]);
  assert.deepEqual(after.projectFiles, { "p-b": "read", "p-new": "write" });
  assert.deepEqual(after.sessionProjectIds, ["p-b", "p-new"]);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.approvalRevision, approvalRevision(before));
  assert.equal(after.approvalRevision, 3);
  const touched = ["projectIds", "projectFiles", "sessionProjectIds", "revision"];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (!touched.includes(key)) assert.deepEqual(after[key], before[key], key);
  assert.equal(changed(), 1);
});

test("a policy without an approval revision keeps its revision as the approval revision", (t) => {
  const { access, id } = fixture(t);
  const { approvalRevision: _, ...older } = access.stored(id);
  access.write(id, older);
  const after = grantCreatedProject(access, id, "p-new");
  assert.equal(after.revision, 5);
  assert.equal(after.approvalRevision, 4);
});

test("without coding the grant leaves sessionProjectIds alone; a second grant adds nothing twice", (t) => {
  const { access, id, changed } = fixture(t);
  const first = grantCreatedProject(access, id, "p-new");
  assert.deepEqual(first.sessionProjectIds, ["p-b"]);
  assert.deepEqual(first.projectIds, ["p-b", "p-new", "p-old"]);
  assert.equal(first.projectFiles["p-new"], "write");
  const again = grantCreatedProject(access, id, "p-new");
  assert.deepEqual(again, first, "an unchanged grant is not written again");
  const coding = grantCreatedProject(access, id, "p-new", { coding: true });
  assert.deepEqual(coding.projectIds, ["p-b", "p-new", "p-old"]);
  assert.deepEqual(coding.sessionProjectIds, ["p-b", "p-new"]);
  assert.equal(coding.revision, first.revision + 1);
  assert.equal(changed(), 2);
});

test("switching coding needs the project grant, and switching off never needs it", (t) => {
  const { access, id, changed } = fixture(t);
  grantCreatedProject(access, id, "p-new");
  const on = setCreatedProjectCoding(access, id, "p-new", true);
  assert.deepEqual(on.sessionProjectIds, ["p-b", "p-new"]);
  assert.equal(on.approvalRevision, 3);
  const off = setCreatedProjectCoding(access, id, "p-new", false);
  assert.deepEqual(off.sessionProjectIds, ["p-b"]);
  assert.deepEqual(off.projectIds, ["p-b", "p-new", "p-old"], "the grant stays");
  assert.equal(off.projectFiles["p-new"], "write");
  assert.equal(off.revision, on.revision + 1);
  assert.equal(off.approvalRevision, 3);
  assert.equal(changed(), 3);

  const revisionBefore = access.stored(id).revision;
  assert.throws(
    () => setCreatedProjectCoding(access, id, "gone", true),
    (e) => toolError(e).code === "PROJECT_NOT_GRANTED",
  );
  assert.equal(access.stored(id).revision, revisionBefore);
  setCreatedProjectCoding(access, id, "gone", false);
  assert.ok(!access.stored(id).projectIds.includes("gone"));
  assert.ok(!access.stored(id).sessionProjectIds.includes("gone"));
  assert.equal(access.stored(id).revision, revisionBefore, "nothing to switch off");
  assert.equal(changed(), 3);
});

test("an archived agent or temporary member gets no grant", (t) => {
  const { store, access, id, changed } = fixture(t);
  const member = store.reserveMember({
    id: crypto.randomUUID(),
    parent: id,
    assignment: { name: "Scout", role: "Research", assignment: "Look around" },
    snapshot: store.getAssistant(id),
    teamId: "team-1",
    lifetime: "task",
  });
  access.write(member.id, { ...access.stored(member.id), projectIds: ["p-b"] });
  const archived = store.setArchived(id, 1, "2026-10-28T12:00:00Z");
  assert.ok(archived.archivedAt);
  for (const agent of [id, member.id]) {
    const before = access.stored(agent);
    for (const run of [
      () => grantCreatedProject(access, agent, "p-new", { coding: true }),
      () => setCreatedProjectCoding(access, agent, "p-b", true),
      () => setCreatedProjectCoding(access, agent, "p-b", false),
    ])
      assert.throws(run, (e) => e.status === 403);
    assert.deepEqual(access.stored(agent), before);
  }
  assert.equal(changed(), 0);
});

test("the store lists, matches and times only the agent's own rows", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-agent-projects-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const projects = new AgentProjectStore(store.db);
  new AgentProjectStore(store.db); // creating the table twice is harmless
  projects.add({ projectId: "p-2", assistantId: "a", createdAt: "2026-10-28T12:00:00Z" });
  projects.add({ projectId: "p-1", assistantId: "a", createdAt: "2026-10-28T10:00:00Z" });
  projects.add({ projectId: "p-3", assistantId: "b", createdAt: "2026-10-28T11:00:00Z" });
  assert.deepEqual(projects.list("a"), [
    { projectId: "p-1", createdAt: "2026-10-28T10:00:00Z" },
    { projectId: "p-2", createdAt: "2026-10-28T12:00:00Z" },
  ]);
  assert.deepEqual(projects.list("c"), []);
  assert.equal(projects.createdBy("a", "p-1"), true);
  assert.equal(projects.createdBy("a", "p-3"), false);
  assert.equal(projects.createdBy("b", "p-3"), true);
  assert.equal(projects.createdBy("c", "p-1"), false);
  assert.deepEqual(projects.times("a"), [
    Date.parse("2026-10-28T10:00:00Z"),
    Date.parse("2026-10-28T12:00:00Z"),
  ]);
  assert.deepEqual(projects.times("c"), []);
  assert.throws(() =>
    projects.add({
      projectId: "p-1",
      assistantId: "a",
      createdAt: "2026-10-29T00:00:00Z",
    }),
  );
});
