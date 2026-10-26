import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { grantAccessBody } from "../../web/features/connections/agent-grants.js";
import {
  workBody,
  workServer,
} from "../../web/features/assistants/settings/agent-settings-fields.js";

// AC-ZG-4: "Benutzt von" in Zugänge and the agent's Access tab change the same
// setting. Zugänge sends the body grantAccessBody() builds to PUT /assistants/:id/work;
// the Access tab sends workBody(). Each side must see the other's change.

async function fixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const ssh = f.application.sshManagement;
  const key = await ssh.ui("createKey", { name: "lab key" });
  const host = await ssh.ui("createHost", {
    name: "lab",
    host: "lab.invalid",
    port: 22,
    username: "deploy",
    keyId: key.id,
    hostKey: key.publicKey,
  });
  const secret = await (
    await f.request("/api/secrets", {
      method: "POST",
      body: { name: "TOKEN", description: "", value: "value-3c1" },
    })
  ).json();
  const agent = f.application.assistants.store.createAssistant({
    name: "Ops",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: false, reminders: false },
  });
  const read = async (path) => {
    const response = await f.request(path);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const policy = () => read(`/api/assistants/${agent.id}/access`);
  const usage = () => read("/api/connections/usage");
  const saveWork = (body) =>
    f.request(`/api/assistants/${agent.id}/work`, { method: "PUT", body });
  return { f, host, secret, agent, policy, usage, saveWork };
}

test("a grant, mode change and revoke from Zugänge change the agent's Access tab", async (t) => {
  const { host, secret, agent, policy, usage, saveWork } = await fixture(t);
  const zugaenge = async (change) => {
    const access = grantAccessBody(await policy(), change);
    const response = await saveWork({ access });
    assert.equal(response.status, 200, await response.clone().text());
  };
  await zugaenge({ kind: "ssh", itemId: host.id, mode: "trusted" });
  // The Access tab's draft reads the same grant.
  assert.deepEqual(workServer(await policy(), null).sshAccesses, [
    { accessId: host.id, mode: "trusted" },
  ]);
  assert.deepEqual((await usage()).ssh[host.id].agents, [
    { id: agent.id, name: "Ops", kind: "agent", via: "grant", mode: "trusted" },
  ]);
  await zugaenge({ kind: "ssh", itemId: host.id, mode: "approval" });
  assert.equal(workServer(await policy(), null).sshAccesses[0].mode, "approval");
  await zugaenge({ kind: "secret", itemId: secret.id, mode: true });
  assert.deepEqual(workServer(await policy(), null).secretIds, [secret.id]);
  await zugaenge({ kind: "ssh", itemId: host.id, mode: null });
  await zugaenge({ kind: "secret", itemId: secret.id, mode: null });
  const after = workServer(await policy(), null);
  assert.deepEqual(after.sshAccesses, []);
  assert.deepEqual(after.secretIds, []);
  const listed = await usage();
  assert.deepEqual(listed.ssh[host.id].agents, []);
  assert.deepEqual(listed.secrets[secret.id].agents, []);
});

test("a grant saved on the agent's Access tab shows in Zugänge and can be revoked there", async (t) => {
  const { host, secret, agent, policy, usage, saveWork } = await fixture(t);
  const current = await policy();
  const values = {
    ...workServer(current, null),
    sshAccesses: [{ accessId: host.id, mode: "routines" }],
    secretIds: [secret.id],
  };
  const saved = await saveWork(
    workBody({
      values,
      changed: ["sshAccesses", "secretIds"],
      revisions: { access: current.revision },
      withTeam: false,
    }),
  );
  assert.equal(saved.status, 200, await saved.clone().text());
  const listed = await usage();
  assert.deepEqual(listed.ssh[host.id].agents, [
    { id: agent.id, name: "Ops", kind: "agent", via: "grant", mode: "routines" },
  ]);
  assert.deepEqual(listed.secrets[secret.id].agents, [
    { id: agent.id, name: "Ops", kind: "agent", via: "grant", mode: null },
  ]);
  // Zugänge revokes the host; the secret stays granted.
  const revoked = await saveWork({
    access: grantAccessBody(await policy(), { kind: "ssh", itemId: host.id, mode: null }),
  });
  assert.equal(revoked.status, 200);
  const after = workServer(await policy(), null);
  assert.deepEqual(after.sshAccesses, []);
  assert.deepEqual(after.secretIds, [secret.id]);
});

test("a stale revision is refused and changes nothing (never retried silently)", async (t) => {
  const { host, policy, saveWork } = await fixture(t);
  const stale = await policy();
  const first = await saveWork({
    access: grantAccessBody(stale, { kind: "ssh", itemId: host.id, mode: "approval" }),
  });
  assert.equal(first.status, 200);
  const second = await saveWork({
    access: grantAccessBody(stale, { kind: "ssh", itemId: host.id, mode: "routines" }),
  });
  assert.equal(second.status, 409);
  assert.deepEqual((await policy()).sshAccesses, [
    { accessId: host.id, mode: "approval" },
  ]);
});
