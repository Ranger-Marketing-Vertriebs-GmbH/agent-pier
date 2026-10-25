import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";

const routes = ["/api/connections/usage", "/api/connections/problems"];
const access = (revision, changes = {}) => ({
  revision,
  projectIds: [],
  pipelineIds: [],
  memoryWrite: false,
  autonomous: false,
  publish: false,
  ...changes,
});

async function sshHost(f, name = "nas-01") {
  const ssh = f.application.sshManagement;
  const key = await ssh.ui("createKey", { name: `${name} key` });
  return ssh.ui("createHost", {
    name,
    host: `${name}.invalid`,
    port: 22,
    username: "deploy",
    keyId: key.id,
    hostKey: key.publicKey,
  });
}

const json = async (f, route) => {
  const response = await f.request(route);
  assert.equal(response.status, 200, route);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
};

test("connection reads are owner-only and leave agent services alone while agents are off", async (t) => {
  const f = await applicationFixture(t);
  for (const route of routes) assert.equal((await fetch(f.url + route)).status, 401);
  const { cookie } = await signedInUser(f);
  for (const route of routes)
    assert.equal((await f.request(route, { headers: { cookie } })).status, 404);
  const host = await sshHost(f);
  const secret = await (
    await f.request("/api/secrets", {
      method: "POST",
      body: { name: "API_KEY", description: "", value: "value-1f9" },
    })
  ).json();
  const usage = await json(f, routes[0]);
  assert.equal(usage.agentsEnabled, false);
  assert.equal(f.application.assistants, null);
  assert.deepEqual(usage.ssh[host.id], {
    type: "ssh",
    agents: [],
    hooks: [],
    sessions: 0,
    lastUsedAt: null,
  });
  assert.deepEqual(usage.secrets[secret.id], { agents: [], sessions: 0 });
  assert.deepEqual(usage.github, {});
  assert.deepEqual(usage.lastUseCovers, ["agentSsh", "agentSftp", "sessionSftp"]);
  const problems = await json(f, routes[1]);
  assert.equal(problems.agentsEnabled, false);
  assert.equal(problems.services, null);
  assert.deepEqual(problems.ssh, { total: 1, problems: [], warnings: [], unknown: [] });
  assert.equal(problems.secrets.total, 1);
  assert.equal(JSON.stringify([usage, problems]).includes("value-1f9"), false);

  // A source that fails is null, never an empty map.
  f.application.secrets.list = () => {
    throw new Error("unreadable");
  };
  assert.equal((await json(f, routes[0])).secrets, null);
  assert.equal((await json(f, routes[1])).secrets, null);
});

test("usage names the agents granted an SSH host, a secret and the sessions using them", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const host = await sshHost(f);
  const secret = await (
    await f.request("/api/secrets", {
      method: "POST",
      body: { name: "TOKEN", description: "", value: "value-77a" },
    })
  ).json();
  const agent = f.application.assistants.store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: false, reminders: false },
  });
  const saved = await f.request(`/api/assistants/${agent.id}/work`, {
    method: "PUT",
    body: {
      access: access(0, {
        sshAccesses: [{ accessId: host.id, mode: "approval" }],
        secretIds: [secret.id],
      }),
    },
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const session = await (
    await f.request("/api/sessions", {
      method: "POST",
      body: { accountId: "local-shell", cwd: f.home, sshAccessIds: [host.id] },
    })
  ).json();
  const usage = await json(f, routes[0]);
  assert.equal(usage.agentsEnabled, true);
  assert.deepEqual(usage.ssh[host.id].agents, [
    { id: agent.id, name: "Home", kind: "agent", via: "grant", mode: "approval" },
  ]);
  assert.deepEqual(usage.ssh[host.id].hooks, []);
  assert.equal(usage.ssh[host.id].sessions, 1);
  assert.deepEqual(usage.secrets[secret.id].agents, [
    { id: agent.id, name: "Home", kind: "agent", via: "grant", mode: null },
  ]);
  await f.application.sessions.stop(session.id);
  assert.equal((await json(f, routes[0])).ssh[host.id].sessions, 0);
  const problems = await json(f, routes[1]);
  assert.equal(problems.agentsEnabled, true);
  assert.ok(problems.services);
});

test("the last SSH test result is listed, counted as a problem and survives a restart", async (t) => {
  const f = await applicationFixture(t);
  const host = await sshHost(f);
  const listed = async () =>
    (await json(f, "/api/ssh-accesses")).accesses.find((a) => a.id === host.id);
  assert.equal((await listed()).lastTest, null);
  f.application.sshAccesses.run = async () => {
    throw Object.assign(new Error("Command failed"), {
      code: 255,
      stderr:
        "deploy@nas-01.invalid: Permission denied (publickey) token=ghp_0123456789abcdefghij0123456789abcd\n",
    });
  };
  const tested = await f.request(`/api/ssh-accesses/${host.id}/test`, { method: "POST" });
  assert.equal(tested.status, 502);
  const answer = await tested.text();
  assert.equal(answer.includes("Permission denied"), false);
  await f.restart();
  const after = (await listed()).lastTest;
  assert.equal(after.ok, false);
  assert.equal(after.hostKeyMismatch, false);
  assert.equal(after.messageKey, "ssh.connectionFailed");
  assert.match(
    after.detail,
    /^deploy@nas-01\.invalid: Permission denied \(publickey\) token=\[redacted\]$/,
  );
  const problems = await json(f, routes[1]);
  assert.deepEqual(problems.ssh.problems, [{ id: host.id, reasons: ["testFailed"] }]);
  // A renamed host keeps its result; the edit answer carries it as well.
  const renamed = await f.request(`/api/ssh-accesses/${host.id}`, {
    method: "PATCH",
    body: { name: "nas-renamed" },
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).lastTest.ok, false);
  f.application.sshAccesses.run = async () => ({ stdout: "", stderr: "" });
  const passed = await f.request(`/api/ssh-accesses/${host.id}/test`, { method: "POST" });
  assert.deepEqual(await passed.json(), { ok: true });
  assert.equal((await listed()).lastTest.ok, true);
  assert.deepEqual((await json(f, routes[1])).ssh.problems, []);
});
