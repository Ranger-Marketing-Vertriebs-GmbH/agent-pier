import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { SessionAgentGrants } from "../../server/features/session-talk/session-agent-grants.js";
import {
  sessionProjectId,
  talkAgent,
  talkAgentsFor,
  talkSessionsFor,
  talkVia,
} from "../../server/features/assistants/session-talk/talk-reach.js";

const userAccess = {
  mode: "own",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};

// The workflow fixture with session grants and two running sessions of its project.
async function setup(t) {
  const f = await workflowFixture(t);
  const grants = new SessionAgentGrants({ dataDir: f.dataDir });
  const session = (id, projectId = f.project.id) => ({
    id,
    createdAt: "2026-11-13T10:00:00.000Z",
    tool: "codex",
    status: "running",
    ...(projectId ? { sshTools: { project: { projectId } } } : {}),
  });
  const first = session("session-1");
  const second = session("session-2");
  const sessions = [first, second];
  f.services.sessionAgentGrants = grants;
  f.services.sessions = { list: async () => sessions };
  const w = f.workflows;
  const save = (policy) =>
    w.access.save(f.id, { ...f.policy, ...policy }, w.access.get(f.id).revision);
  const patchBody = (patch) => {
    const body = { ...f.store.storedAssistant(f.id), ...patch };
    f.store.db
      .prepare("UPDATE assistants SET body=? WHERE id=?")
      .run(JSON.stringify(body), f.id);
  };
  return { ...f, w, grants, first, second, sessions, session, save, patchBody };
}

const reachedBy = async (f) =>
  (await talkSessionsFor(f.w, f.id)).map(({ session, via }) => [session.id, via]);

test("sessionProjectId reads the session's project binding", () => {
  assert.equal(sessionProjectId({ sshTools: { project: { projectId: "p" } } }), "p");
  assert.equal(sessionProjectId({}), null);
  assert.equal(sessionProjectId(null), null);
});

test("no grant: not visible both ways", async (t) => {
  const f = await setup(t);
  assert.ok(talkAgent(f.w, f.id));
  assert.deepEqual(talkAgentsFor(f.w, f.first), []);
  assert.deepEqual(await talkSessionsFor(f.w, f.id), []);
  assert.equal(talkVia(f.w, f.id, f.first), null);
  // Unknown agents and sessions never throw.
  assert.equal(talkAgent(f.w, "missing"), null);
  assert.equal(talkVia(f.w, "missing", f.first), null);
  assert.deepEqual(await talkSessionsFor(f.w, "missing"), []);
  assert.deepEqual(talkAgentsFor(f.w, null), []);
});

test("the project grant reaches every session of the project", async (t) => {
  const f = await setup(t);
  f.save({ talkProjectIds: [f.project.id] });
  assert.equal(talkVia(f.w, f.id, f.first), "project");
  assert.deepEqual(talkAgentsFor(f.w, f.second), [
    { assistantId: f.id, name: f.store.getAssistant(f.id).name, via: "project" },
  ]);
  assert.deepEqual(await reachedBy(f), [
    ["session-1", "project"],
    ["session-2", "project"],
  ]);
  // A stopped session of the project is not reached.
  f.second.status = "stopped";
  assert.deepEqual(await reachedBy(f), [["session-1", "project"]]);
});

test("a session grant reaches one session without the project grant", async (t) => {
  const f = await setup(t);
  f.save({ projectIds: [] });
  f.grants.set(f.first, [f.id]);
  assert.equal(talkVia(f.w, f.id, f.first), "session");
  assert.equal(talkVia(f.w, f.id, f.second), null);
  assert.deepEqual(await reachedBy(f), [["session-1", "session"]]);
  assert.deepEqual(
    talkAgentsFor(f.w, f.first).map((a) => a.via),
    ["session"],
  );
});

test("coding sessions on does not grant talk", async (t) => {
  const f = await setup(t);
  f.save({ sessionProjectIds: [f.project.id] });
  assert.equal(talkVia(f.w, f.id, f.first), null);
  assert.deepEqual(await talkSessionsFor(f.w, f.id), []);
});

test("a user agent is never reachable", async (t) => {
  const f = await setup(t);
  f.save({ talkProjectIds: [f.project.id] });
  f.grants.set(f.first, [f.id]);
  f.patchBody({ userAccess });
  assert.equal(talkAgent(f.w, f.id), null);
  assert.equal(talkVia(f.w, f.id, f.first), null);
  assert.deepEqual(talkAgentsFor(f.w, f.first), []);
  assert.deepEqual(await talkSessionsFor(f.w, f.id), []);
});

test("an archived agent or a temporary member is never reachable", async (t) => {
  const f = await setup(t);
  f.save({ talkProjectIds: [f.project.id] });
  f.grants.set(f.first, [f.id]);
  const before = f.store.storedAssistant(f.id);
  for (const patch of [
    { archivedAt: "2026-11-13T11:00:00.000Z" },
    { teamMemberId: "member-1", lifetime: "temporary" },
  ]) {
    f.patchBody(patch);
    assert.equal(talkAgent(f.w, f.id), null);
    assert.equal(talkVia(f.w, f.id, f.first), null);
    assert.deepEqual(talkAgentsFor(f.w, f.first), []);
    assert.deepEqual(await talkSessionsFor(f.w, f.id), []);
    f.store.db
      .prepare("UPDATE assistants SET body=? WHERE id=?")
      .run(JSON.stringify(before), f.id);
  }
  // A permanent member is the owner's own agent.
  f.patchBody({ teamMemberId: "member-1", lifetime: "permanent" });
  assert.equal(talkVia(f.w, f.id, f.first), "project");
});

test("a session without a project gets session grants only", async (t) => {
  const f = await setup(t);
  f.save({ talkProjectIds: [f.project.id] });
  const loose = f.session("session-3", null);
  f.sessions.push(loose);
  assert.equal(talkVia(f.w, f.id, loose), null);
  f.grants.set(loose, [f.id]);
  assert.equal(talkVia(f.w, f.id, loose), "session");
  assert.deepEqual(await reachedBy(f), [
    ["session-1", "project"],
    ["session-2", "project"],
    ["session-3", "session"],
  ]);
});

test("agents are listed by name", async (t) => {
  const f = await setup(t);
  const other = f.store.createAssistant({
    name: "Aardvark",
    model: { connectionId: "c", modelId: "m" },
  });
  f.grants.set(f.first, [f.id, other.id]);
  const names = talkAgentsFor(f.w, f.first).map((a) => a.name);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(names[0], "Aardvark");
});
