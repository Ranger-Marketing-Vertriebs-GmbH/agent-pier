import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Backup } from "../../server/features/operations/backup.js";
import { assistantOmissions } from "../../server/features/operations/assistant-backup.js";
import { mcpServerOmission } from "../../server/features/operations/snapshot.js";
import { decodeArchive } from "../../server/features/operations/archive.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { backupCopy as de } from "../../web/lib/i18n/de/operations.js";
import { backupCopy as en } from "../../web/lib/i18n/en/operations.js";

// The backup scope lists server identifiers; each must reach the user as a translated
// label, never as a raw key or as English text in the German UI.
test("every backup scope entry has a German and an English label", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-backup-scope-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const backup = new Backup({ dataDir });
  const keys = new Set([...assistantOmissions, mcpServerOmission]);
  for (const withCredentials of [false, true]) {
    const plan = backup.plan({ includeHistory: true, withCredentials });
    for (const key of [...plan.components, ...plan.omissions, plan.consistency])
      keys.add(key);
  }
  const englishKeys = new Set(
    [...keys].filter((key) => /^[A-Z]/.test(key) && key.includes(" ")),
  );
  for (const key of keys) {
    assert.equal(typeof en.descriptions[key], "string", `EN label for ${key}`);
    assert.equal(typeof de.descriptions[key], "string", `DE label for ${key}`);
    if (englishKeys.has(key))
      assert.notEqual(de.descriptions[key], key, `German label for ${key}`);
  }
});

test("a host with central MCP servers declares them as left out of host backups", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-backup-mcp-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const backup = new Backup({ dataDir });
  assert.ok(!backup.plan({}).omissions.includes(mcpServerOmission));
  const servers = new McpServerStore({ dataDir, pathEnv: "/fake/bin" });
  servers.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/v1?token=query-secret",
    headers: { Authorization: "Bearer header-secret" },
  });
  servers.close();
  for (const withCredentials of [false, true]) {
    const created = await backup.create({
      withCredentials,
      passphrase: "mcp backup fixture phrase",
    });
    assert.ok(created.manifest.omissions.includes(mcpServerOmission));
    const { files } = decodeArchive(fs.readFileSync(created.file));
    assert.equal(
      files.some((member) => member.path.startsWith("mcp-servers/")),
      false,
    );
  }
});
