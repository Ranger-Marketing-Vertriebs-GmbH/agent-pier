import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
for (const encrypted of [false, true])
  test(`central provider backup preserves connection identity with encrypted credentials ${encrypted}`, async (t) => {
    const temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-connection-backup-")),
    );
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const dataDir = path.join(temporary, "data"),
      target = path.join(temporary, "restored");
    const connections = new ProviderConnections({ dataDir });
    const connection = connections.create({
      name: "Portable",
      providerId: "openrouter",
      apiKey: "fixture-private-central",
    });
    const passphrase = "provider backup fixture phrase";
    const backup = await new Backup({ dataDir }).create({
      withCredentials: encrypted,
      ...(encrypted ? { passphrase } : {}),
    });
    const report = await new Restore({ dataDir }).apply({
      archive: backup.file,
      targetDataDir: target,
      ...(encrypted ? { passphrase } : {}),
    });
    const restored = new ProviderConnections({ dataDir: target });
    assert.equal(restored.get(connection.id).hasSecret, encrypted);
    assert.equal(
      restored.secret(connection.id)?.apiKey,
      encrypted ? "fixture-private-central" : undefined,
    );
    assert.equal(
      report.credentialsNeedingLogin.includes(`provider:${connection.id}`),
      !encrypted,
    );
  });
