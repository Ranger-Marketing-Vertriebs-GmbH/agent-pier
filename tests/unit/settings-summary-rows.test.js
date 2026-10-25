import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  accessRows,
  operationsRows,
} from "../../web/features/settings/settings-summary-rows.js";

const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));
const reset = (t) => t.after(() => setLanguage("de", { persist: false }));

test("unknown summary parts stay unknown and a real zero stays zero", (t) => {
  reset(t);
  setLanguage("de", { persist: false });
  const access = byId(accessRows(undefined));
  for (const id of ["mcp", "remote", "ssh", "secrets", "github", "users"])
    assert.equal(access[id].value, null, id);
  const operations = byId(
    operationsRows({ diagnostics: null, backups: null, updates: null }),
  );
  assert.equal(operations.diagnostics.value, null);
  assert.equal(operations.backups.value, null);
  assert.equal(operations.updates.value, null);
  assert.equal(operations.audit.value, undefined);
  assert.equal(operations.audit.sub, "Besitzer, Benutzer, System, MCP");
  assert.equal(byId(accessRows({ github: { count: 0 } })).github.value, 0);
  assert.equal(
    byId(operationsRows({ backups: { count: 0, lastAt: null } })).backups.value,
    0,
  );
});

test("access rows describe MCP clients and how AgentPier is reachable", (t) => {
  reset(t);
  setLanguage("de", { persist: false });
  const rows = byId(
    accessRows({
      mcp: { available: true, activeGrants: 1 },
      remote: { tailscale: true, network: true },
      ssh: { count: 3 },
      github: { count: 2 },
    }),
  );
  assert.equal(rows.mcp.label, "MCP & Zugriffe");
  assert.equal(rows.mcp.value, "1 verbundener Client");
  assert.deepEqual(rows.remote.status, { tone: "ok", text: "Tailscale · Netzwerk" });
  assert.equal(rows.ssh.value, 3);
  assert.equal(rows.github.value, 2);
  assert.equal(byId(accessRows({ users: { count: 2 } })).users.value, 2);
  const secrets = byId(accessRows({ secrets: { count: 0 } })).secrets;
  assert.deepEqual(
    [secrets.label, secrets.sub, secrets.value],
    ["Geheimnisse", "Token und URLs für Agenten und Coding-CLIs", 0],
  );
  assert.deepEqual(
    accessRows({}).map((row) => row.id),
    ["mcp", "remote", "ssh", "secrets", "github", "users"],
  );
  assert.equal(byId(accessRows({})).users.label, "Benutzer");
  assert.deepEqual(
    byId(accessRows({ mcp: { available: false, activeGrants: 0 } })).mcp.status,
    { tone: "warn", text: "Nicht verfügbar" },
  );
  assert.equal(
    byId(accessRows({ remote: { tailscale: false, network: false } })).remote.value,
    "Lokal",
  );
  assert.deepEqual(
    byId(
      accessRows({ remote: { tailscale: true, network: false, restartRequired: true } }),
    ).remote.status,
    { tone: "warn", text: "Neustart nötig" },
  );
  setLanguage("en", { persist: false });
  assert.equal(
    byId(accessRows({ mcp: { available: true, activeGrants: 2 } })).mcp.value,
    "2 connected clients",
  );
});

test("operations rows rank failures over warnings and flag a newer version", (t) => {
  reset(t);
  setLanguage("de", { persist: false });
  const rows = (operations) => byId(operationsRows(operations));
  const at = "2026-10-12T09:14:00.000Z";
  assert.deepEqual(
    rows({ diagnostics: { generatedAt: at, failed: 2, warnings: 1 } }).diagnostics.status,
    { tone: "error", text: "2 Fehler" },
  );
  assert.deepEqual(
    rows({ diagnostics: { generatedAt: at, failed: 0, warnings: 1 } }).diagnostics.status,
    { tone: "warn", text: "1 Warnung" },
  );
  const ok = rows({
    diagnostics: { generatedAt: at, failed: 0, warnings: 0 },
  }).diagnostics;
  assert.deepEqual(ok.status, { tone: "ok", text: "In Ordnung" });
  assert.match(ok.sub, /^Geprüft am /);
  const updates = rows({
    updates: { current: "1.28.1", checked: true, available: "1.29.0" },
  }).updates;
  assert.equal(updates.sub, "Installierte Version 1.28.1");
  assert.deepEqual(updates.status, { tone: "warn", text: "1.29.0 verfügbar" });
  assert.equal(
    rows({ updates: { current: "1.28.1", checked: true, available: null } }).updates
      .value,
    "Aktuell",
  );
  assert.equal(
    rows({ updates: { current: "1.28.1", checked: false, available: null } }).updates
      .value,
    undefined,
  );
  const backups = rows({
    backups: { count: 4, lastAt: "2026-10-11T22:00:00.000Z" },
  }).backups;
  assert.equal(backups.value, 4);
  assert.match(backups.sub, /^Letzte Sicherung /);
  setLanguage("en", { persist: false });
  assert.match(
    rows({ backups: { count: 4, lastAt: "2026-10-11T22:00:00.000Z" } }).backups.sub,
    /^Last backup /,
  );
  assert.equal(
    rows({ updates: { current: "1", checked: true, available: "2" } }).updates.status
      .text,
    "2 available",
  );
});
