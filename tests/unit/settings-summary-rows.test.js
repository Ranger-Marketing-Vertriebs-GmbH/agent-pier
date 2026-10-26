import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { routePath } from "../../web/app/routes.js";
import {
  movedRows,
  operationsRows,
  storageRow,
} from "../../web/features/settings/settings-summary-rows.js";

const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));
const reset = (t) => t.after(() => setLanguage("de", { persist: false }));

test("unknown summary parts stay unknown and a real zero stays zero", (t) => {
  reset(t);
  setLanguage("de", { persist: false });
  const moved = byId(movedRows(undefined));
  assert.equal(moved.mcp.value, null);
  assert.equal(moved.agents.value, undefined);
  assert.equal(moved.connections.value, undefined);
  const operations = byId(
    operationsRows({ diagnostics: null, backups: null, updates: null }),
  );
  assert.equal(operations.diagnostics.value, null);
  assert.equal(operations.backups.value, null);
  assert.equal(operations.updates.value, null);
  assert.equal(operations.audit.value, undefined);
  assert.equal(operations.audit.sub, "Besitzer, Benutzer, System, MCP");
  assert.equal(
    byId(movedRows({ mcp: { available: true, activeGrants: 0 } })).mcp.value,
    "0 verbundene Clients",
  );
  assert.equal(
    byId(operationsRows({ backups: { count: 0, lastAt: null } })).backups.value,
    0,
  );
  assert.equal(storageRow(null).value, null);
  assert.equal(storageRow({ disk: {} }).value, null);
});

test("the moved group links the new places and counts MCP clients", (t) => {
  reset(t);
  setLanguage("de", { persist: false });
  const rows = movedRows({ mcp: { available: true, activeGrants: 1 } });
  assert.deepEqual(
    rows.map((row) => [row.id, routePath(row.route)]),
    [
      ["agents", "/agents?tab=runtime"],
      ["connections", "/connections"],
      ["mcp", "/coding/clis?tab=mcp"],
    ],
  );
  const byKey = byId(rows);
  assert.equal(byKey.agents.sub, "Jetzt unter Agenten › Laufzeit");
  assert.equal(byKey.connections.sub, "Jetzt unter Zugänge");
  assert.equal(byKey.mcp.value, "1 verbundener Client");
  assert.deepEqual(
    byId(movedRows({ mcp: { available: false, activeGrants: 0 } })).mcp.status,
    { tone: "warn", text: "Nicht verfügbar" },
  );
  setLanguage("en", { persist: false });
  assert.equal(
    byId(movedRows({ mcp: { available: true, activeGrants: 2 } })).mcp.value,
    "2 connected clients",
  );
  assert.equal(byId(movedRows({})).connections.sub, "Now under Connections");
});

test("the storage row shows the free disk space", (t) => {
  reset(t);
  setLanguage("de", { persist: false });
  const row = storageRow({ disk: { freeBytes: 5 * 1024 ** 3, totalBytes: 10 } });
  assert.equal(row.label, "Speicher");
  assert.match(row.value, /^5\sGB frei$/);
  setLanguage("en", { persist: false });
  assert.equal(storageRow(null).label, "Storage");
  assert.match(storageRow({ disk: { freeBytes: 1024 ** 3 } }).value, /^1\sGB free$/);
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
