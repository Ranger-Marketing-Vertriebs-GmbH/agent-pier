import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";

const timeout = 30000;
const userAccess = {
  mode: "own",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};

// A coding CLI stand-in that stays alive (also as Codex's app-server backend).
function idleCli(f) {
  const executable = path.join(f.root, "idle-cli.cjs");
  fs.writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, {
    mode: 0o700,
  });
  f.application.accounts.command = () => ({ command: executable, args: [], env: {} });
}

/** An app with agents on, an owner agent, a user agent and the idle CLI. */
async function fixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  assert.ok(service, "the agent feature runs");
  const model = { connectionId: "c", modelId: "m" };
  const agent = service.store.createAssistant({ name: "Network Architect", model });
  const userAgent = service.store.createAssistant({ name: "Her Agent", model });
  const body = { ...service.store.storedAssistant(userAgent.id), userAccess };
  service.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), userAgent.id);
  idleCli(f);
  return Object.assign(f, { service, agent, userAgent });
}

async function launch(f, extra = {}) {
  const response = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-codex", cwd: f.project, agentbus: false, ...extra },
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text);
}

const route = (session) => `/api/sessions/${session.id}/agent-accesses`;
const put = (f, session, body) => f.request(route(session), { method: "PUT", body });

test("GET and PUT answer the session's agent access", { timeout }, async (t) => {
  const f = await fixture(t);
  const session = await launch(f);
  const first = await (await f.request(route(session))).json();
  assert.deepEqual(first, {
    agents: [{ id: f.agent.id, name: "Network Architect" }],
    assignedIds: [],
    inheritedIds: [],
    tools: "missing",
  });
  const saved = await put(f, session, { assistantIds: [f.agent.id] });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual((await saved.json()).assignedIds, [f.agent.id]);
  const read = await (await f.request(route(session))).json();
  assert.deepEqual(read.assignedIds, [f.agent.id]);
  // The launch dialog's list holds the owner's agents only.
  assert.deepEqual(await (await f.request("/api/session-talk/agents")).json(), {
    agents: [{ id: f.agent.id, name: "Network Architect" }],
  });
  // A user agent, an unknown agent and a body with another field are refused.
  for (const body of [
    { assistantIds: [f.userAgent.id] },
    { assistantIds: ["missing"] },
    { assistantIds: [], extra: 1 },
    { assistantIds: "x" },
  ])
    assert.equal((await put(f, session, body)).status, 400, JSON.stringify(body));
  assert.equal((await f.request("/api/sessions/gone/agent-accesses")).status, 404);
  // An empty list removes the grant.
  assert.deepEqual(
    (await (await put(f, session, { assistantIds: [] })).json()).assignedIds,
    [],
  );
  assert.equal(fs.existsSync(f.application.sessionAgentGrants.file(session.id)), false);
});

test("a launch stores the grant; stop and delete remove it", { timeout }, async (t) => {
  const f = await fixture(t);
  const grants = f.application.sessionAgentGrants;
  // Refused before a session exists: a user agent, a login session.
  const refused = await f.request("/api/sessions", {
    method: "POST",
    body: {
      accountId: "local-codex",
      cwd: f.project,
      agentbus: false,
      agentAccessIds: [f.userAgent.id],
    },
  });
  assert.equal(refused.status, 400);
  const shell = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-shell", cwd: f.project, agentAccessIds: [f.agent.id] },
  });
  assert.equal(shell.status, 400);
  const session = await launch(f, { agentAccessIds: [f.agent.id] });
  const file = grants.file(session.id);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual((await (await f.request(route(session))).json()).assignedIds, [
    f.agent.id,
  ]);
  const stopped = await f.request(`/api/sessions/${session.id}/stop`, { method: "POST" });
  assert.equal(stopped.status, 200, await stopped.text());
  assert.equal(fs.existsSync(file), false);
  // A grant left behind (as after a crash) goes with the delete.
  fs.writeFileSync(file, "{}");
  const removed = await f.request(`/api/sessions/${session.id}`, { method: "DELETE" });
  assert.equal(removed.status, 204);
  assert.equal(fs.existsSync(file), false);
});

test("the live topic pushes the new value after PUT", { timeout }, async (t) => {
  const f = await fixture(t);
  const session = await launch(f);
  const topic = `session.agent-access:${session.id}`;
  const live = openLive(f);
  t.after(() => live.ws.close());
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic });
  const first = await live.next((frame) => frame.topic === topic, 5000);
  assert.equal(first.type, "snapshot");
  assert.deepEqual(first.data, await (await f.request(route(session))).json());
  const pushed = live.next(
    (frame) => frame.topic === topic && frame.data?.assignedIds?.length === 1,
    5000,
  );
  await put(f, session, { assistantIds: [f.agent.id] });
  assert.deepEqual((await pushed).data, await (await f.request(route(session))).json());
  // A project grant of the agent reaches the session through the agent's change.
  const access = f.service.workflows.access;
  const projectId = session.sshTools?.project?.projectId;
  assert.ok(projectId, "the fixture project binds the session");
  const inherited = live.next(
    (frame) => frame.topic === topic && frame.data?.inheritedIds?.length === 1,
    5000,
  );
  const policy = {
    projectIds: [projectId],
    pipelineIds: [],
    memoryWrite: false,
    autonomous: false,
    publish: false,
    talkProjectIds: [projectId],
  };
  access.save(f.agent.id, policy, access.get(f.agent.id).revision);
  f.service.changed();
  assert.deepEqual((await inherited).data.inheritedIds, [f.agent.id]);
  live.ws.close();
});

test(
  "with agents off the list is empty and a grant is refused",
  { timeout },
  async (t) => {
    const f = await applicationFixture(t);
    idleCli(f);
    assert.deepEqual(await (await f.request("/api/session-talk/agents")).json(), {
      agents: [],
    });
    const session = await launch(f);
    const body = await (await f.request(route(session))).json();
    assert.deepEqual(
      { ...body, tools: undefined },
      {
        agents: [],
        assignedIds: [],
        inheritedIds: [],
        tools: undefined,
      },
    );
    assert.equal((await put(f, session, { assistantIds: ["agent-1"] })).status, 409);
    assert.equal((await put(f, session, { assistantIds: [] })).status, 200);
  },
);
