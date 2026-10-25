import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { agentSshFixture, waitFor } from "../helpers/agent-ssh-fixture.js";
import { SecretStore } from "../../server/features/secrets/secret-store.js";
import {
  AgentSecrets,
  connectAgentSecrets,
} from "../../server/features/secrets/agent-secrets.js";
import { writeSecretFile } from "../../server/features/secrets/secret-format.js";
import { AssistantEvents } from "../../server/features/assistants/assistant-events.js";

const owner = { kind: "owner" };
const emptyPolicy = {
  projectIds: [],
  pipelineIds: [],
  memoryWrite: false,
  autonomous: false,
  publish: false,
};

async function fixture(t) {
  const f = await agentSshFixture(t);
  const secrets = new SecretStore({ dataDir: f.dataDir });
  t.after(() => secrets.db.close());
  f.services.secrets = secrets;
  const workspaces = path.join(f.dataDir, "agent-workspaces");
  const agentSecrets = new AgentSecrets({
    store: secrets,
    access: f.workflows.access,
    assistants: f.assistants,
    workspaces,
  });
  const workspace = (id) => {
    fs.mkdirSync(path.join(workspaces, id), { recursive: true });
    return id;
  };
  workspace(f.id);
  const grantSecrets = (secretIds, id = f.id) =>
    f.workflows.access.save(
      id,
      { ...(id === f.id ? f.policy : emptyPolicy), secretIds },
      f.workflows.access.get(id).revision,
    );
  // A grant row written directly, as one stored before the agent became ineligible.
  const storeGrant = (id, secretIds) =>
    f.workflows.access.write(id, { ...f.workflows.access.get(id), secretIds });
  const read = (id = f.id) => fs.readFileSync(agentSecrets.file(id), "utf8");
  const exists = (id = f.id) => fs.existsSync(agentSecrets.file(id));
  return {
    ...f,
    secrets,
    agentSecrets,
    workspaces,
    workspace,
    grantSecrets,
    storeGrant,
    read,
    exists,
  };
}

test("a granted secret reaches the agent's file, 0600, and follows value changes", async (t) => {
  const f = await fixture(t);
  const s1 = f.secrets.create({ name: "S1", value: "it's $HOME" }, owner);
  f.grantSecrets([s1.id]);
  assert.equal(
    f.agentSecrets.file(f.id),
    path.join(f.workspaces, f.id, ".agentpier", "secrets.env"),
  );
  assert.equal(await f.agentSecrets.sync(f.id), "written");
  assert.match(f.read(), /^S1='it'\\''s \$HOME'$/m);
  assert.equal(fs.statSync(f.agentSecrets.file(f.id)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.agentSecrets.file(f.id))).mode & 0o777, 0o700);
  assert.equal(await f.agentSecrets.sync(f.id), "unchanged");
  f.secrets.update(s1.id, { value: "second" }, owner);
  await f.agentSecrets.syncAll();
  assert.match(f.read(), /^S1='second'$/m);
});

test("revoking the grant or deleting the secret removes the file", async (t) => {
  const f = await fixture(t);
  const s1 = f.secrets.create({ name: "S1", value: "one" }, owner);
  const s2 = f.secrets.create({ name: "S2", value: "two" }, owner);
  f.grantSecrets([s1.id, s2.id]);
  await f.agentSecrets.sync(f.id);
  assert.match(f.read(), /^S2='two'$/m);
  f.grantSecrets([s1.id]);
  await f.agentSecrets.sync(f.id);
  assert.doesNotMatch(f.read(), /S2=/);
  f.secrets.remove(s1.id, owner);
  assert.equal(await f.agentSecrets.sync(f.id), "removed");
  assert.equal(f.exists(), false);
  // The deleted secret leaves no inert grant behind.
  assert.deepEqual(f.workflows.access.secretIds(f.id), []);
  assert.deepEqual(f.workflows.access.get(f.id).secretIds, []);
});

test("a deleted or edited file is restored by the next sync", async (t) => {
  const f = await fixture(t);
  const s1 = f.secrets.create({ name: "S1", value: "one" }, owner);
  f.grantSecrets([s1.id]);
  await f.agentSecrets.sync(f.id);
  fs.unlinkSync(f.agentSecrets.file(f.id));
  assert.equal(await f.agentSecrets.sync(f.id), "written");
  assert.match(f.read(), /^S1='one'$/m);
  fs.writeFileSync(f.agentSecrets.file(f.id), "S1='tampered'\n");
  fs.chmodSync(f.agentSecrets.file(f.id), 0o644);
  assert.equal(await f.agentSecrets.sync(f.id), "written");
  assert.match(f.read(), /^S1='one'$/m);
  assert.equal(fs.statSync(f.agentSecrets.file(f.id)).mode & 0o777, 0o600);
});

test("the pre-turn hook restores a deleted file", async (t) => {
  const f = await fixture(t);
  const s1 = f.secrets.create({ name: "S1", value: "one" }, owner);
  f.grantSecrets([s1.id]);
  const synced = [];
  const config = { syncSecrets: (id) => synced.push(id) && f.agentSecrets.sync(id) };
  const { AssistantConfig } =
    await import("../../server/features/assistants/assistant-config.js");
  await AssistantConfig.prototype.deliverSecrets.call(config, { id: f.id });
  assert.deepEqual(synced, [f.id]);
  assert.match(f.read(), /^S1='one'$/m);
  fs.unlinkSync(f.agentSecrets.file(f.id));
  await AssistantConfig.prototype.deliverSecrets.call(config, { id: f.id });
  assert.equal(f.exists(), true);
  // A failing sync never fails the turn.
  const failing = { syncSecrets: async () => Promise.reject(Error("disk")) };
  await AssistantConfig.prototype.deliverSecrets.call(failing, { id: f.id });
});

test("temporary members, archived agents and user agents get no file", async (t) => {
  const f = await fixture(t);
  const s1 = f.secrets.create({ name: "S1", value: "one" }, owner);
  const task = f.member({ lifetime: "task" });
  const archived = f.member({ lifetime: "permanent", name: "Old" });
  const user = f.member({ lifetime: "permanent", name: "Home" });
  for (const agent of [task, archived, user]) {
    f.workspace(agent.id);
    f.storeGrant(agent.id, [s1.id]);
    // A file from before the agent became ineligible goes as well.
    await writeSecretFile(f.agentSecrets.file(agent.id), [{ name: "S1", value: "one" }]);
  }
  f.store.db
    .prepare(
      "UPDATE assistants SET body=json_set(body,'$.archivedAt','2026-10-16T00:00:00.000Z') WHERE id=?",
    )
    .run(archived.id);
  f.store.changeUserAgent(user.id, {
    userAccess: { mode: "own", members: [{ userId: "u1", level: "chat" }], released: [] },
  });
  for (const agent of [task, archived, user]) {
    assert.equal(
      f.agentSecrets.eligible(f.store.getAssistant(agent.id)),
      false,
      agent.name,
    );
    await f.agentSecrets.sync(agent.id);
    assert.equal(f.exists(agent.id), false, agent.name);
  }
  assert.equal(f.agentSecrets.eligible(f.store.getAssistant(f.id)), true);
});

test("an agent with its own bot for other people gets no file", async (t) => {
  const f = await fixture(t);
  const s1 = f.secrets.create({ name: "S1", value: "one" }, owner);
  f.grantSecrets([s1.id]);
  await f.agentSecrets.sync(f.id);
  f.services.assistantTelegramSenders = { connected: (id) => id === f.id };
  assert.equal(f.agentSecrets.eligible(f.store.getAssistant(f.id)), false);
  await f.agentSecrets.sync(f.id);
  assert.equal(f.exists(), false);
});

test("an agent without a workspace yet gets none created", async (t) => {
  const f = await fixture(t);
  const s1 = f.secrets.create({ name: "S1", value: "one" }, owner);
  const other = f.member({ lifetime: "permanent", name: "New" });
  f.grantSecrets([s1.id], other.id);
  assert.equal(await f.agentSecrets.sync(other.id), "unchanged");
  assert.equal(fs.existsSync(path.join(f.workspaces, other.id)), false);
});

test("a symlinked secrets file is replaced, its target left alone", async (t) => {
  const f = await fixture(t);
  const s1 = f.secrets.create({ name: "S1", value: "one" }, owner);
  f.grantSecrets([s1.id]);
  await f.agentSecrets.sync(f.id);
  const file = f.agentSecrets.file(f.id);
  const target = path.join(f.dataDir, "elsewhere.env");
  fs.writeFileSync(target, fs.readFileSync(file));
  fs.chmodSync(target, 0o644);
  fs.unlinkSync(file);
  fs.symlinkSync(target, file);
  assert.equal(await writeSecretFile(file, [{ name: "S1", value: "one" }]), "written");
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
});

// The production wiring: AssistantService.changed publishes on its events.
function connected(f) {
  const config = {};
  const events = new AssistantEvents();
  f.assistants.changed = () => events.publish({ type: "change" });
  const agentSecrets = connectAgentSecrets(f.secrets, {
    assistants: { store: f.store, config, events },
    assistantWorkflows: f.workflows,
    assistantRuntime: { paths: { workspaces: f.workspaces } },
  });
  return { config, agentSecrets };
}

test("the connected delivery follows secret changes and grant saves at once", async (t) => {
  const f = await fixture(t);
  const { config, agentSecrets } = connected(f);
  const s1 = f.secrets.create({ name: "S1", value: "one" }, owner);
  f.grantSecrets([s1.id]);
  await waitFor(() => f.exists() && /^S1='one'$/m.test(f.read()));
  f.secrets.update(s1.id, { value: "two" }, owner);
  await waitFor(() => /^S1='two'$/m.test(f.read()));
  f.grantSecrets([]);
  await waitFor(() => !f.exists());
  f.grantSecrets([s1.id]);
  await waitFor(() => f.exists());
  assert.equal(typeof config.syncSecrets, "function");
  agentSecrets.close();
  assert.equal(config.syncSecrets, undefined);
  f.secrets.update(s1.id, { value: "three" }, owner);
  await new Promise((resolve) => setImmediate(resolve));
  await agentSecrets.queue.catch(() => {});
  assert.match(f.read(), /^S1='two'$/m);
  assert.equal(connectAgentSecrets(null, {}), null);
});

test("archiving an agent or making it a user agent removes its file at once", async (t) => {
  const f = await fixture(t);
  connected(f);
  const s1 = f.secrets.create({ name: "S1", value: "one" }, owner);
  const member = f.member({ lifetime: "permanent", name: "Scout" });
  f.workspace(member.id);
  f.grantSecrets([s1.id]);
  f.grantSecrets([s1.id], member.id);
  await waitFor(() => f.exists() && f.exists(member.id));
  // Archiving goes through the team store, then announces the change.
  f.store.db
    .prepare(
      "UPDATE assistants SET body=json_set(body,'$.archivedAt','2026-10-16T00:00:00.000Z') WHERE id=?",
    )
    .run(member.id);
  f.assistants.changed();
  await waitFor(() => !f.exists(member.id));
  f.store.changeUserAgent(f.id, {
    userAccess: { mode: "own", members: [{ userId: "u1", level: "chat" }], released: [] },
  });
  f.assistants.changed();
  await waitFor(() => !f.exists());
});

test("a burst of changes shares one pass", async (t) => {
  const f = await fixture(t);
  const passes = [];
  const syncAll = f.agentSecrets.syncAll.bind(f.agentSecrets);
  f.agentSecrets.syncAll = () => passes.push(1) && syncAll();
  await Promise.all([f.agentSecrets.refresh(), f.agentSecrets.refresh()]);
  assert.equal(passes.length, 1);
  await f.agentSecrets.refresh();
  assert.equal(passes.length, 2);
});
