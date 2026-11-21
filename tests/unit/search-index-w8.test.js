// ⌘K entries found missing in feature test W8 (B15): services for agents, Free up
// space, Restore backup, and German names people type.
import test from "node:test";
import assert from "node:assert/strict";
import { routePath } from "../../web/app/routes.js";
import { buildSearchIndex } from "../../web/app/search-entries.js";
import { searchEntries } from "../../web/app/search-index.js";

const index = buildSearchIndex({ agentsEnabled: true });
const first = (query, entries = index) => searchEntries(entries, query)[0]?.items[0];
const pathOf = (item) => (item?.target.route ? routePath(item.target.route) : null);

test("each service for agents opens its own detail in both languages", () => {
  for (const [queries, item] of [
    [["Web search", "Websuche"], "web-search"],
    [["PDF reading", "PDF-Lesen"], "pdf-model"],
    [["Speech recognition", "Spracherkennung"], "speech"],
  ])
    for (const query of queries)
      assert.equal(
        pathOf(first(query)),
        `/connections?section=services&item=${item}`,
        query,
      );
  // They need agents, like their category.
  const off = buildSearchIndex({ agentsEnabled: false });
  assert.equal(
    off.some((entry) => entry.id === "page:connections-services-web-search"),
    false,
  );
});

test("Free up space opens the storage cleanup in both languages", () => {
  for (const query of ["Free up space", "Speicher freigeben", "Speicher aufräumen"]) {
    const item = first(query);
    assert.equal(item.id, "page:settings-free-space", query);
    assert.equal(item.target.pending, "storage-cleanup", query);
  }
});

test("Restore backup and Create backup open their dialogs on the backups page", () => {
  for (const [query, pending] of [
    ["Restore backup", "backup-restore"],
    ["Sicherung wiederherstellen", "backup-restore"],
    ["Inspect and restore backup", "backup-restore"],
    ["Create backup", "backup-create"],
    ["Sicherung erstellen", "backup-create"],
  ]) {
    const item = first(query);
    assert.equal(pathOf(item), "/settings/backups", query);
    assert.equal(item.target.pending, pending, query);
  }
});

test("German names people type find their place", () => {
  for (const [query, path] of [
    ["E-Mail-Konten", "/connections?section=mail"],
    ["E-Mail-Konto", "/connections?section=mail"],
    ["Plane-Verbindung", "/connections?section=tickets"],
    ["Standardordner", "/settings"],
    ["Email accounts", "/connections?section=mail"],
  ])
    assert.equal(pathOf(first(query)), path, query);
  assert.equal(first("E-Mail-Konto hinzufügen").target.pending, "mail-add");
  assert.equal(first("Plane-Verbindung hinzufügen").target.pending, "plane-add");
});
