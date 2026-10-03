import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { messageIdentity } from "../../server/lib/i18n/message-identity.js";
import {
  auditRows,
  gitInit,
  parsed,
  projectHost,
  projectSession,
} from "../helpers/project-rebind.js";

async function publishedBeforeInit(t, f) {
  const s = await projectSession(t, f);
  const { host } = await projectHost(f, s.fromId);
  const original = parsed(await s.publish());
  assert.equal(original.projectId, s.fromId);
  return { s, host, original };
}
async function assertMoved(f, { s, host, original }) {
  const toId = (await projectScope(s.cwd)).id;
  const updated = await s.publish({ title: "Updated", artifactId: original.id });
  assert.notEqual(updated.isError, true, JSON.stringify(updated));
  assert.equal(parsed(updated).projectId, toId);
  assert.equal((await f.application.artifacts.get(original.id)).projectId, toId);
  assert.equal(f.application.sshAccesses.get(host.id).projectId, toId);
  assert.equal((await s.record()).sshTools.project.projectId, toId);
  assert.ok(
    (await f.application.sshSessions.effective(await s.record())).includes(host.id),
  );
  return toId;
}

test("a Git identity registered first by another session still receives the move", async (t) => {
  const f = await applicationFixture(t);
  const before = await publishedBeforeInit(t, f);
  gitInit(before.s.cwd);
  // A second session started after git init registers the Git identity.
  const second = await projectSession(t, f);
  assert.notEqual(second.fromId, before.s.fromId);
  await assertMoved(f, before);
  assert.equal(auditRows(f, "project.updated").length, 1);
});

for (const [step, owner] of [
  ["SSH", "sshManagement"],
  ["artifact", "artifacts"],
])
  test(`an interrupted ${step} move resumes on the next call`, async (t) => {
    const f = await applicationFixture(t);
    const before = await publishedBeforeInit(t, f);
    const service = f.application[owner];
    const method = owner === "artifacts" ? "moveProject" : "adoptProject";
    const original = service[method];
    service[method] = async () => {
      service[method] = original;
      throw Object.assign(new Error("Injected failure"), { code: "EIO" });
    };
    gitInit(before.s.cwd);
    const failed = await before.s.publish({ title: "Interrupted" });
    assert.equal(failed.isError, true);
    const toId = await assertMoved(f, before);
    assert.equal(f.application.memory.reboundTo(before.s.fromId), toId);
    assert.equal(auditRows(f, "project.updated").length, 1);
  });

test("OAuth grants and pipeline verification follow the rebound project", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f);
  const steps = [{ name: "Test", command: "npm test", timeoutMs: 60000, blocking: true }];
  f.application.pipelineDefinitions.saveVerification(s.fromId, { steps });
  const access = f.application.mcpAccess.initialize();
  access.checkAccessToken = () => ({
    extra: { grant: { id: "grant", projectIds: [s.fromId, "other-project"] } },
  });
  gitInit(s.cwd);
  await s.ssh("ssh_list_keys");
  const toId = (await projectScope(s.cwd)).id;
  assert.deepEqual(
    f.application.mcpAccess.checkAccessToken("token").extra.grant.projectIds,
    [toId, "other-project"],
  );
  assert.deepEqual(f.application.pipelineDefinitions.getVerification(toId).steps, steps);
  assert.deepEqual(f.application.pipelineDefinitions.getVerification(s.fromId).steps, []);
});

test("a key prepared while the project rebinds is created under the Git project", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f);
  const keys = f.application.sshManagement.store.keyStore;
  const prepare = keys.prepare;
  keys.prepare = async (input) => {
    const prepared = await prepare.call(keys, input);
    gitInit(s.cwd);
    await f.application.projectRebind.rebind({ cwd: s.cwd, previousIds: [s.fromId] });
    return prepared;
  };
  const key = await s.ssh("ssh_generate_key", { name: "Deploy", requestId: "key" });
  const toId = (await projectScope(s.cwd)).id;
  assert.equal(key.projectId, toId);
  assert.equal(keys.get(key.id).projectId, toId);
  assert.equal((await s.ssh("ssh_list_keys")).total, 1);
  const replay = await s.ssh("ssh_generate_key", { name: "Deploy", requestId: "key" });
  assert.equal(replay.id, key.id);
});

test("a busy session does not block the rebind and is updated later", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f);
  const busy = await projectSession(t, f);
  f.application.projectRebind.sessionWaitMs = 50;
  let release;
  const held = f.application.sessions.serial(
    () => new Promise((resolve) => (release = resolve)),
    busy.session.id,
  );
  gitInit(s.cwd);
  const published = await s.publish();
  assert.notEqual(published.isError, true, JSON.stringify(published));
  const toId = (await projectScope(s.cwd)).id;
  assert.equal((await s.record()).sshTools.project.projectId, toId);
  assert.ok(f.application.projectRebind.incomplete.has(s.fromId));
  release();
  await held;
  await f.application.sessions.serial(async () => {}, busy.session.id);
  assert.equal((await busy.record()).sshTools.project.projectId, toId);
  await s.publish();
  assert.ok(!f.application.projectRebind.incomplete.has(s.fromId));
});

test("project-changed messages keep distinct stable identifiers", () => {
  assert.equal(
    messageIdentity(serverMessages.ssh.projectChangedReload).messageKey,
    "ssh.projectChangedReload",
  );
  assert.equal(
    messageIdentity(serverMessages.artifacts.ARTIFACT_PROJECT_CHANGED).messageKey,
    "artifacts.ARTIFACT_PROJECT_CHANGED",
  );
});

test("verification steps merge into an existing Git project so the move converges", async (t) => {
  const f = await applicationFixture(t);
  const s = await projectSession(t, f);
  const definitions = f.application.pipelineDefinitions;
  const step = (name) => ({ name, command: name, timeoutMs: 60000, blocking: true });
  definitions.saveVerification(s.fromId, { steps: [step("shared"), step("plain")] });
  gitInit(s.cwd);
  const toId = (await projectScope(s.cwd)).id;
  definitions.saveVerification(toId, { steps: [step("git"), step("shared")] });
  const rebind = f.application.projectRebind;
  const ensure = () => rebind.ensure({ cwd: s.cwd, previousIds: [s.fromId] });
  assert.equal((await ensure()).id, toId);
  assert.deepEqual(definitions.getVerification(toId).steps, [
    step("git"),
    step("shared"),
    step("plain"),
  ]);
  assert.ok(!definitions.hasVerification(s.fromId));
  assert.equal(rebind.remnants(s.fromId), false);
  let adopted = 0;
  const adopt = rebind.adopt;
  rebind.adopt = (...args) => {
    adopted += 1;
    return adopt.apply(rebind, args);
  };
  assert.equal((await ensure()).id, toId);
  assert.equal(adopted, 0, "A completed move takes the fast path");
});
