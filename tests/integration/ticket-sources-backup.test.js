import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TicketStore } from "../../server/features/tickets/ticket-store.js";
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
