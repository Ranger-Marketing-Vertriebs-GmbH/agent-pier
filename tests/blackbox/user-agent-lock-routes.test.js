import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { ownUserAgent } from "../helpers/user-agents.js";

const json = (response) => response.json();
const locked = async (response, label) => {
  assert.equal(response.status, 409, label);
  const body = await json(response);
  assert.equal(body.code, "USER_AGENT_LOCKED", label);
  assert.equal(body.messageKey, "assistants.userAgentLocked", label);
};
const access = (revision, changes = {}) => ({
  revision,
  projectIds: [],
  pipelineIds: [],
  memoryWrite: false,
  autonomous: false,
  publish: false,
  ...changes,
});

test("locked capabilities cannot be enabled for user agents via the API", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const { agent } = await ownUserAgent(f);
  const patch = (body) =>
    f.request(`/api/assistants/${agent.id}`, {
      method: "PATCH",
      body: { revision: agent.revision, ...body },
    });
  await locked(
    await patch({ shell: "full", confirmShell: true, confirmFull: true }),
    "shell full",
  );
  await locked(await patch({ shell: "approval", confirmShell: true }), "shell approval");
  await locked(await patch({ browserVisible: true }), "visible browser");
  // Restating the locked values is no change.
  assert.equal((await patch({ shell: "off", browserVisible: false })).status, 200);

  fs.mkdirSync(path.join(f.project, ".git"));
  const project = await f.application.memory.register(f.project);
  const put = (changes) =>
    f.request(`/api/assistants/${agent.id}/access`, {
      method: "PUT",
      body: access(0, changes),
    });
  for (const changes of [
    { sshAccesses: [{ accessId: "host", mode: "ask" }] },
    { pipelineIds: ["pipeline"] },
    { github: { credentialId: "profile", level: "read" } },
    { projectIds: [project.id] },
    { memoryWrite: true },
    { autonomous: true },
    { publish: true },
  ])
    await locked(await put(changes), JSON.stringify(changes));
  assert.equal((await put({})).status, 200);

  const coding = await f.request(
    `/api/assistant-project-access/${project.id}/${agent.id}`,
    {
      method: "PUT",
      body: {
        expected: { coding: false, folder: "none" },
        coding: true,
        folder: "none",
      },
    },
  );
  await locked(coding, "coding grant");

  const policy = f.application.assistants.teams.store.policy(agent.id);
  await locked(
    await f.request(`/api/assistants/${agent.id}/team-policy`, {
      method: "PUT",
      body: { revision: policy.revision, autonomous: true },
    }),
    "team policy",
  );
  await locked(
    await f.request(`/api/assistant-telegram-senders/${agent.id}`, {
      method: "PUT",
      body: { token: "123:abc", people: [], revision: null },
    }),
    "telegram senders",
  );

  const listed = (await json(await f.request("/api/assistants"))).assistants.find(
    (a) => a.id === agent.id,
  );
  assert.equal(listed.shell, "off");
  assert.equal(listed.browserVisible, false);
  const stored = await json(await f.request(`/api/assistants/${agent.id}/access`));
  assert.deepEqual(
    [stored.projectIds, stored.pipelineIds, stored.sshAccesses, stored.github],
    [[], [], [], null],
  );
});

test("owner may bind registered MCP servers to user agents", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const { agent } = await ownUserAgent(f);
  const created = await f.request("/api/mcp-servers", {
    method: "POST",
    body: {
      name: "local",
      transport: "stdio",
      command: process.execPath,
      args: ["server.js"],
      confirmStdio: true,
    },
  });
  assert.equal(created.status, 201);
  const local = await json(created);
  const bind = (body) =>
    f.request(`/api/assistants/${agent.id}`, {
      method: "PATCH",
      body: { revision: agent.revision, mcpServers: [local.id], ...body },
    });
  const refused = await bind({});
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, "MCP_STDIO_CONFIRMATION_REQUIRED");
  const bound = await bind({ confirmStdio: true });
  assert.equal(bound.status, 200);
  assert.deepEqual((await json(bound)).mcpServers, [local.id]);
});
