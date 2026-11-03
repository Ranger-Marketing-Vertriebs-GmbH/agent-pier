import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TicketStore } from "../../server/features/tickets/ticket-store.js";
import { Backup } from "../../server/features/operations/backup.js";
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
