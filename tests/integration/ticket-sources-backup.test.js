import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TicketStore } from "../../server/features/tickets/ticket-store.js";
import { TicketRuleStore } from "../../server/features/tickets/rule-store.js";
import { ruleInput } from "../../server/features/tickets/rule-input.js";
import { Backup } from "../../server/features/operations/backup.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { Restore } from "../../server/features/operations/restore.js";

for (const encrypted of [false, true])
  test(`ticket sources survive a backup, the token only sealed (${encrypted})`, async (t) => {
    const temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-ticket-backup-")),
    );
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const dataDir = path.join(temporary, "data"),
      target = path.join(temporary, "restored");
    const store = new TicketStore({ dataDir });
    const { id } = store.createConnection({
      name: "Plane",
      baseUrl: "https://plane.example.com",
      workspaceSlug: "acme",
      token: "plane-secret",
    });
    store.setProjectLink("p1", "/repo", {
      plane: {
        connectionId: id,
        planeProjectId: "11111111-1111-4111-8111-111111111111",
        identifier: "ACME",
        name: "Acme",
      },
    });
    const passphrase = "ticket backup fixture phrase";
    const backup = await new Backup({ dataDir }).create({
      withCredentials: encrypted,
      ...(encrypted ? { passphrase } : {}),
    });
    if (!encrypted)
      assert.equal(
        (await fs.readFile(backup.file)).includes(Buffer.from("plane-secret")),
        false,
      );
    const report = await new Restore({ dataDir }).apply({
      archive: backup.file,
      targetDataDir: target,
      ...(encrypted ? { passphrase } : {}),
    });
    const restored = new TicketStore({ dataDir: target });
    assert.equal(restored.listConnections()[0].name, "Plane");
    assert.equal(restored.projectLink("p1").plane.connectionId, id);
    assert.equal(restored.token(id), encrypted ? "plane-secret" : null);
    assert.equal(restored.listConnections()[0].hasSecret, encrypted);
    assert.equal(
      report.credentialsNeedingLogin.includes(`ticket-source:${id}`),
      !encrypted,
    );
  });

test("a project mapping moves ticket links and starts to the new project id", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-ticket-map-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    target = path.join(root, "target"),
    project = path.join(root, "project"),
    destination = path.join(root, "destination");
  await fs.mkdir(project);
  await fs.mkdir(destination);
  const memory = new ProjectMemory({ dataDir: source });
  t.after(() => memory.close());
  const scope = await memory.register(project);
  const store = new TicketStore({ dataDir: source });
  const { id } = store.createConnection({
    name: "Plane",
    baseUrl: "https://plane.example.com",
    workspaceSlug: "acme",
    token: "plane-secret",
  });
  store.setProjectLink(scope.id, scope.cwd, {
    plane: {
      connectionId: id,
      planeProjectId: "11111111-1111-4111-8111-111111111111",
      identifier: "ACME",
      name: "Acme",
    },
  });
  store.addStart({
    projectId: scope.id,
    source: "plane",
    key: "ACME-1",
    kind: "session",
    targetId: "s1",
  });
  const backup = await new Backup({ dataDir: source, home: root }).create();
  const report = await new Restore({ dataDir: source }).apply({
    archive: backup.file,
    targetDataDir: target,
    projectMap: { [scope.id]: destination },
  });
  const newId = report.projectMappings[0].to;
  assert.notEqual(newId, scope.id);
  const restored = new TicketStore({ dataDir: target });
  assert.equal(restored.projectLink(newId).plane.connectionId, id);
  assert.equal(restored.projectLink(newId).repoPath, destination);
  assert.equal(restored.projectLink(scope.id).plane, null);
  assert.equal(restored.starts(newId).length, 1);
  assert.equal(restored.starts(scope.id).length, 0);
  restored.setProjectLink(newId, destination, { plane: null });
  restored.removeConnection(id);
});

const RULE = {
  source: "github",
  label: "agent",
  kind: "session",
  allowMerge: false,
  session: { tool: "claude" },
};
/** A rule with a pickup and a failed, already pushed poll status. */
function seedRule(dataDir, projectId) {
  const rules = new TicketRuleStore({ dataDir });
  const rule = rules.create(projectId, ruleInput(RULE));
  rules.addPickups(projectId, [
    { source: "github", key: "acme/app#7", ruleId: rule.id, itemId: "i1", at: 5 },
  ]);
  rules.setStatus(projectId, rule.id, {
    checkedAt: 9,
    error: { code: "unauthorized", since: 8 },
    notified: "unauthorized",
  });
  return rule;
}
const RESET = { checkedAt: null, error: null, notified: null };

for (const encrypted of [false, true])
  test(`ticket rules and pickups survive a backup and restore (${encrypted})`, async (t) => {
    const temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-rule-backup-")),
    );
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const dataDir = path.join(temporary, "data"),
      target = path.join(temporary, "restored");
    const rule = seedRule(dataDir, "p1");
    const passphrase = "ticket rule backup fixture phrase";
    const backup = await new Backup({ dataDir }).create({
      withCredentials: encrypted,
      ...(encrypted ? { passphrase } : {}),
    });
    await new Restore({ dataDir }).apply({
      archive: backup.file,
      targetDataDir: target,
      ...(encrypted ? { passphrase } : {}),
    });
    const restored = new TicketRuleStore({ dataDir: target });
    const [back] = restored.rules("p1");
    assert.equal(back.id, rule.id);
    assert.equal(back.label, "agent");
    assert.deepEqual(back.options, rule.options);
    assert.deepEqual(back.status, RESET);
    assert.equal(restored.picked("p1", "github", "acme/app#7").ruleId, rule.id);
    assert.equal(restored.picked("p1", "github", "acme/app#8"), null);
  });

test("a restore with a project mapping moves rules and pickups to the new project id and resets status", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-rule-map-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    target = path.join(root, "target"),
    project = path.join(root, "project"),
    destination = path.join(root, "destination");
  await fs.mkdir(project);
  await fs.mkdir(destination);
  const memory = new ProjectMemory({ dataDir: source });
  t.after(() => memory.close());
  const scope = await memory.register(project);
  const rule = seedRule(source, scope.id);
  const backup = await new Backup({ dataDir: source, home: root }).create();
  const report = await new Restore({ dataDir: source }).apply({
    archive: backup.file,
    targetDataDir: target,
    projectMap: { [scope.id]: destination },
  });
  const newId = report.projectMappings[0].to;
  assert.notEqual(newId, scope.id);
  const restored = new TicketRuleStore({ dataDir: target });
  assert.deepEqual(restored.rules(scope.id), []);
  const [moved] = restored.rules(newId);
  assert.equal(moved.id, rule.id);
  assert.equal(moved.projectId, newId);
  assert.deepEqual(moved.status, RESET);
  assert.equal(restored.picked(newId, "github", "acme/app#7").ruleId, rule.id);
  assert.equal(restored.picked(scope.id, "github", "acme/app#7"), null);
  assert.equal(restored.pickupCount(newId, rule.id), 1);
});

test("a restored rule file of a newer version stays untouched and loads read-only", async (t) => {
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-rule-version-")),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const dataDir = path.join(temporary, "data"),
    target = path.join(temporary, "restored");
  seedRule(dataDir, "p1");
  const file = path.join(dataDir, "ticket-rules.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  const content = JSON.stringify({ ...saved, version: 2 });
  await fs.writeFile(file, content);
  const backup = await new Backup({ dataDir }).create();
  await new Restore({ dataDir }).apply({ archive: backup.file, targetDataDir: target });
  const restoredFile = path.join(target, "ticket-rules.json");
  assert.deepEqual(
    JSON.parse(await fs.readFile(restoredFile, "utf8")),
    JSON.parse(content),
  );
  const restored = new TicketRuleStore({ dataDir: target, log: () => {} });
  assert.deepEqual(restored.locked, { code: "unsupportedVersion", version: 2 });
  assert.deepEqual(restored.allRules(), []);
});
