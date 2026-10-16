import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";

const access = (revision, changes = {}) => ({
  revision,
  projectIds: [],
  pipelineIds: [],
  memoryWrite: false,
  autonomous: false,
  publish: false,
  ...changes,
});

test("SSH grants travel through the catalog, the Work save, the decision route and host removal", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const a = f.application.assistants;
  const ssh = f.application.sshManagement;
  const key = await ssh.ui("createKey", { name: "Agent key" });
  const host = await ssh.ui("createHost", {
    name: "nas-01",
    host: "nas.invalid",
    port: 22,
    username: "deploy",
    keyId: key.id,
    hostKey: key.publicKey,
  });
  const agent = a.store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: false, reminders: false },
  });
  const catalog = await (await f.request("/api/assistant-workspace-catalog")).json();
  assert.deepEqual(
    catalog.sshHosts.map((h) => [h.id, h.name, h.username]),
    [[host.id, "nas-01", "deploy"]],
  );
  assert.equal(JSON.stringify(catalog).includes("PRIVATE KEY"), false);
  const put = (body) =>
    f.request(`/api/assistants/${agent.id}/work`, { method: "PUT", body });
  const saved = await put({
    access: access(0, { sshAccesses: [{ accessId: host.id, mode: "trusted" }] }),
  });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual(body.access.sshAccesses, [{ accessId: host.id, mode: "trusted" }]);
  assert.equal("sshToolChanged" in body, false);
  assert.equal(
    (
      await put({
        access: access(1, { sshAccesses: [{ accessId: "gone", mode: "trusted" }] }),
      })
    ).status,
    409,
  );
  // An SSH approval is decided through the ordinary decision route.
  const conversation = a.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "s",
  });
  const pending = a.workflows.store.reserve({
    assistantId: agent.id,
    conversationId: conversation.id,
    origin: { kind: "owner" },
    key: "ssh:fixture:call",
    state: "awaiting_approval",
    expiresAt: Date.now() + 600000,
    payload: { action: "ssh", accessId: host.id, hostName: "nas-01", command: "uptime" },
  });
  const decided = await f.request(`/api/assistant-actions/${pending.id}/decision`, {
    method: "POST",
    body: { decision: "decline", revision: pending.revision },
  });
  assert.equal(decided.status, 200);
  assert.equal((await decided.json()).state, "declined");
  // Removing the host in Settings → Access → SSH accesses revokes the agent's grant.
  await ssh.ui("removeHost", { id: host.id });
  const after = await (await f.request(`/api/assistants/${agent.id}/access`)).json();
  assert.deepEqual(after.sshAccesses, []);
  assert.equal(after.revision, body.access.revision + 1);
});
