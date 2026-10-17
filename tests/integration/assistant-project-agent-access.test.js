import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import {
  projectAgents,
  setProjectAgent,
} from "../../server/features/assistants/project-agent-access.js";

// An agent with the fixture project registered, a second permanent agent, an
// archived one, and the team store the Work tab saves through.
async function setup(t) {
  const f = await workflowFixture(t);
  const audits = [];
  f.services.audit = { append: (event) => audits.push(event) };
  const teams = new TeamStore({ store: f.store });
  f.assistants.teams = { ...f.assistants.teams, store: teams };
  const other = f.store.createAssistant({
    name: "Scout",
    model: { connectionId: "test", modelId: "fixture" },
  });
  const archived = f.store.createAssistant({
    name: "Old",
    model: { connectionId: "test", modelId: "fixture" },
  });
  f.store.db
    .prepare("UPDATE assistants SET body=json_set(body,'$.archivedAt',?) WHERE id=?")
    .run(new Date().toISOString(), archived.id);
  const services = {
    assistants: f.assistants,
    access: f.workflows.access,
    teams,
  };
  const set = (id, input) => setProjectAgent(services, f.project.id, id, input);
  const list = () => projectAgents(services, f.project.id);
  return { ...f, audits, teams, other, archived, services, set, list };
}
const none = { coding: false, folder: "none" };

test("the project lists permanent agents with their access and hides archived ones", async (t) => {
  const f = await setup(t);
  f.workflows.access.save(
    f.id,
    { ...f.policy, projectFiles: { [f.project.id]: "read" } },
    0,
  );
  const { agents } = f.list();
  assert.deepEqual(
    agents.map((a) => [a.name, a.coding, a.folder]),
    [
      ["Home", true, "read"],
      ["Scout", false, "none"],
    ],
  );
  assert.equal(
    agents.some((a) => a.id === f.archived.id),
    false,
  );
});

test("a change from the project writes the Work tab's access and keeps its other fields", async (t) => {
  const f = await setup(t);
  // The Work tab saved memory proposals after the project page was opened.
  f.workflows.access.save(f.other.id, { ...f.policy, projectIds: [] }, 0);
  const saved = f.set(f.other.id, { expected: none, coding: true, folder: "write" });
  assert.deepEqual([saved.coding, saved.folder], [true, "write"]);
  const policy = f.workflows.access.get(f.other.id);
  assert.deepEqual(policy.projectIds, [f.project.id]);
  assert.deepEqual(policy.projectFiles, { [f.project.id]: "write" });
  assert.equal(policy.memoryWrite, true);
  assert.deepEqual(policy.pipelineIds, f.policy.pipelineIds);
  assert.equal(policy.revision, 2);
  // A Work tab draft from before is refused and reloads, as for any other change.
  assert.throws(() => f.workflows.access.save(f.other.id, f.policy, 1), { status: 409 });
  // The same audit as a Work tab save.
  const grant = f.audits.find((e) => e.details?.kind === "project-grants");
  assert.equal(grant.resourceId, f.other.id);
  assert.deepEqual(grant.details.added, [f.project.id]);
  assert.deepEqual(grant.details.folderChanged, [
    { projectId: f.project.id, from: "none", to: "write" },
  ]);
});

test("folder access needs the project grant, and removing the grant removes the level", async (t) => {
  const f = await setup(t);
  assert.equal(
    f.set(f.other.id, { expected: none, coding: true, folder: "read" }).folder,
    "read",
  );
  const removed = f.set(f.other.id, {
    expected: { coding: true, folder: "read" },
    coding: false,
    folder: "read",
  });
  assert.deepEqual([removed.coding, removed.folder], [false, "none"]);
  assert.deepEqual(f.workflows.access.get(f.other.id).projectFiles, {});
  assert.deepEqual(f.workflows.access.get(f.other.id).projectIds, []);
});

test("a change based on a stale view of this project is refused", async (t) => {
  const f = await setup(t);
  f.set(f.other.id, { expected: none, coding: true, folder: "none" });
  // Meanwhile shown elsewhere as none: the page must reload, nothing changes.
  assert.throws(
    () => f.set(f.other.id, { expected: none, coding: true, folder: "write" }),
    {
      status: 409,
    },
  );
  assert.deepEqual(f.workflows.access.get(f.other.id).projectFiles, {});
  for (const input of [
    { expected: none, coding: true, folder: "admin" },
    { expected: none, coding: "yes", folder: "read" },
    { coding: true, folder: "read" },
  ])
    assert.throws(() => f.set(f.other.id, input), { status: 400 });
  assert.throws(
    () => f.set(f.archived.id, { expected: none, coding: true, folder: "read" }),
    {
      status: 403,
    },
  );
});

test("team members with access are listed read-only through their lead at the live level", async (t) => {
  const f = await setup(t);
  f.workflows.access.save(
    f.id,
    { ...f.policy, projectFiles: { [f.project.id]: "write" } },
    0,
  );
  const request = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "team",
    text: "Build a team that writes the docs",
  });
  f.teams.recordContext(request.id, { kind: "owner", teamAllowed: true });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  const team = f.teams.propose({
    operationId: "team-call",
    parentAttemptId: attempt.id,
    objective: "Docs",
    members: [{ name: "Writer", role: "Docs", assignment: "Write docs" }],
  });
  f.assistants.ledger.transition(attempt.id, "completed");
  f.teams.reserve(team.id);
  const member = f.teams.members(team.id)[0];
  f.teams.write(member, { grants: { projects: { [f.project.id]: "write" } } });
  assert.deepEqual(f.list().members, [
    {
      id: member.assistantId,
      name: "Writer",
      leadId: f.id,
      leadName: "Home",
      folder: "write",
    },
  ]);
  assert.equal(
    f.list().agents.some((a) => a.id === member.assistantId),
    false,
  );
  f.set(f.id, {
    expected: { coding: true, folder: "write" },
    coding: true,
    folder: "read",
  });
  assert.equal(f.list().members[0].folder, "read");
});

test("the HTTP routes read and change one agent's project access", async (t) => {
  const f = await setup(t);
  const { default: express } = await import("express");
  const { assistantProjectAccessRoutes } =
    await import("../../server/http/routes/assistant-project-access.js");
  f.assistants.workflows = f.workflows;
  const app = express();
  app.use(express.json());
  app.use("/api", assistantProjectAccessRoutes({ assistants: f.assistants }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/assistant-project-access/${f.project.id}`;
  const listed = await (await fetch(url)).json();
  assert.equal(listed.agents.find((a) => a.id === f.other.id).folder, "none");
  const put = (body) =>
    fetch(`${url}/${f.other.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const changed = await put({ expected: none, coding: true, folder: "read" });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).folder, "read");
  assert.equal(
    (await put({ expected: none, coding: true, folder: "write" })).status,
    409,
  );
  assert.equal((await fetch(`${url.replace(f.project.id, "missing")}`)).status, 404);
});

test("a deleted pipeline in the agent's grants is dropped instead of blocking the save", async (t) => {
  const f = await setup(t);
  f.workflows.access.save(f.other.id, { ...f.policy, projectIds: [] }, 0);
  // The pipeline is deleted afterwards (pipeline-definitions.js removePipeline).
  f.workflows.s.pipelineDefinitions.listPipelines = () => [];
  f.workflows.s.pipelineDefinitions.getPipeline = () => {
    throw Object.assign(Error("missing"), { status: 400 });
  };
  const saved = f.set(f.other.id, { expected: none, coding: true, folder: "read" });
  assert.equal(saved.folder, "read");
  assert.deepEqual(f.workflows.access.get(f.other.id).pipelineIds, []);
  // The Work tab's own save drops a stored one the same way, while a pipeline
  // newly chosen that does not exist is still refused.
  f.workflows.access.save(f.id, { ...f.policy, pipelineIds: [] }, 0);
  assert.throws(() => f.workflows.access.save(f.id, f.policy, 1), { status: 400 });
  const stored = await setup(t);
  stored.workflows.access.save(stored.id, stored.policy, 0);
  stored.workflows.s.pipelineDefinitions.listPipelines = () => [];
  assert.deepEqual(
    stored.workflows.access.save(stored.id, stored.policy, 1).pipelineIds,
    [],
  );
});

test("every save from the project writes exactly one project audit record", async (t) => {
  const f = await setup(t);
  f.set(f.other.id, { expected: none, coding: true, folder: "write" });
  f.set(f.other.id, {
    expected: { coding: true, folder: "write" },
    coding: false,
    folder: "none",
  });
  const records = f.audits.filter((e) => e.details?.kind === "project-grants");
  assert.equal(records.length, 2);
  assert.deepEqual(records[1].details.removed, [f.project.id]);
  assert.deepEqual(records[1].details.folderChanged, [
    { projectId: f.project.id, from: "write", to: "none" },
  ]);
});
