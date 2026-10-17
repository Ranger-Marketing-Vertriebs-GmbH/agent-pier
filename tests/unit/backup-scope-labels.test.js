import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Backup,
  mcpLoginOmission,
  mcpValueOmission,
} from "../../server/features/operations/backup.js";
import { assistantOmissions } from "../../server/features/operations/assistant-backup.js";
import { profileOmissions } from "../../server/features/operations/profile-capture.js";
import {
  changedOmission,
  removedOmission,
} from "../../server/features/operations/archive-v2.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { backupCopy as de } from "../../web/lib/i18n/de/operations.js";
import { backupCopy as en } from "../../web/lib/i18n/en/operations.js";

// The backup scope lists server identifiers; each must reach the user as a translated
// label, never as a raw key or as English text in the German UI.
test("every backup scope entry has a German and an English label", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-backup-scope-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  // Backups from before AGENTPIER-42 declare the MCP server store as left out.
  const legacy = "MCP servers for agents (definitions, values and bindings)";
  // Backups from before AGENTPIER-56 named only the CLI histories as left out.
  const legacyHistory = [
    "CLI conversation histories",
    "CLI histories are only backed up in backups with a passphrase, and then encrypted",
  ];
  new McpServerStore({ dataDir, pathEnv: "/fake/bin" }).close();
  const backup = new Backup({ dataDir });
  const keys = new Set([
    ...assistantOmissions,
    ...Object.values(profileOmissions),
    removedOmission,
    changedOmission,
    legacy,
    ...legacyHistory,
  ]);
  for (const withCredentials of [false, true])
    for (const includeHistory of [false, true]) {
      const plan = backup.plan({ includeHistory, withCredentials });
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

test("a host with central MCP servers lists them, their sealed values and the logins left out", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-backup-mcp-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const backup = new Backup({ dataDir });
  const scope = (plan) => [...plan.components, ...plan.omissions];
  for (const key of [
    "mcp-servers",
    "encrypted-mcp-server-values",
    mcpLoginOmission,
    mcpValueOmission,
  ])
    assert.ok(!scope(backup.plan({ withCredentials: true })).includes(key));
  new McpServerStore({ dataDir, pathEnv: "/fake/bin" }).close();
  const plain = backup.plan({});
  assert.ok(plain.components.includes("mcp-servers"));
  assert.ok(!plain.components.includes("encrypted-mcp-server-values"));
  assert.ok(plain.omissions.includes(mcpLoginOmission));
  assert.ok(plain.omissions.includes(mcpValueOmission));
  const sealed = backup.plan({ withCredentials: true });
  assert.ok(sealed.components.includes("encrypted-mcp-server-values"));
  assert.ok(sealed.omissions.includes(mcpLoginOmission));
  assert.ok(!sealed.omissions.includes(mcpValueOmission));
});
