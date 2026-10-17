import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import fc from "fast-check";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { issueCapability } from "../../server/features/memory/memory-capability.js";
import { callMemoryTool } from "../../server/features/memory/memory-tools.js";
import { sqliteSnapshotFile } from "../../server/features/operations/snapshot.js";
import { DatabaseSync } from "node:sqlite";

async function fixture(t, options = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-memory-search-")),
  );
  const dataDir = path.join(root, "data");
  const stores = [];
  const open = (extra = options) => {
    const store = new ProjectMemory({ dataDir, home: path.join(root, "home"), ...extra });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = open();
  const folder = async (name) => {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    return store.register(cwd);
  };
  return { root, dataDir, store, open, folder, project: await folder("repo") };
}

// Writes entries oldest first, each in its own millisecond, so date order is the
// reverse of the input order.
function seed(store, projectId, entries) {
  return entries.map(([title, content]) => {
    const start = Date.now();
    while (Date.now() === start);
    return store.write(projectId, { title, content });
  });
}
const titles = (result) => result.items.map((item) => item.title);
const modes = [
  ["full-text index", {}],
  ["LIKE fallback", { fullTextSearch: false }],
];

test("the full-text index is used when SQLite has FTS5", async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.fullText, true);
  const forced = f.open({ fullTextSearch: false });
  assert.equal(forced.fullText, false);
});

for (const [mode, options] of modes) {
  test(`${mode}: several words match in any order and title hits rank first`, async (t) => {
    const f = await fixture(t, options);
    seed(f.store, f.project.id, [
      ["Deploy build", "Steps for the pipeline."],
      ["Release checklist", "Run the deploy script after the build."],
      ["Build cache", "Only the build is mentioned here."],
      ["Unrelated", "Nothing to see."],
    ]);
    const result = f.store.list(f.project.id, { query: "build deploy" });
    assert.equal(result.total, 2);
    assert.deepEqual(titles(result), ["Deploy build", "Release checklist"]);
    // Newest first keeps today's date order on the same matches.
    assert.deepEqual(
      titles(f.store.list(f.project.id, { query: "build deploy", sort: "newest" })),
      ["Release checklist", "Deploy build"],
    );
    assert.deepEqual(
      titles(f.store.list(f.project.id, { query: "build", sort: "newest" })),
      ["Build cache", "Release checklist", "Deploy build"],
    );
    // Without a search term the list stays in date order.
    assert.deepEqual(titles(f.store.list(f.project.id)), [
      "Unrelated",
      "Build cache",
      "Release checklist",
      "Deploy build",
    ]);
    assert.equal(f.store.list(f.project.id, { query: "BUILD" }).total, 3);
  });

  test(`${mode}: exact references come before looser matches`, async (t) => {
    const f = await fixture(t, options);
    seed(f.store, f.project.id, [
      ["Ticket notes", "Fixed in ABC-123 last week."],
      ["ABC 123 overview", "abc and 123 are mentioned separately."],
      ["Router", "The handler lives in server/x.js now."],
      ["Server x.json layout", "server x json"],
      ["Docs link", "See https://example.com/a for details."],
      ["Example com a", "example com a"],
      ["Symbol", "Call parseConfig before start."],
      ["Parse config", "parse config"],
    ]);
    for (const [query, first] of [
      ["ABC-123", "Ticket notes"],
      ["server/x.js", "Router"],
      ["https://example.com/a", "Docs link"],
      ["parseConfig", "Symbol"],
    ])
      assert.equal(f.store.list(f.project.id, { query }).items[0].title, first, query);
  });

  test(`${mode}: wildcards, quotes and operators are plain text`, async (t) => {
    const f = await fixture(t, options);
    seed(f.store, f.project.id, [
      ["Literal", "literal %_ text"],
      ["Words", "alpha beta"],
    ]);
    assert.equal(f.store.list(f.project.id, { query: "%_" }).total, 1);
    assert.equal(f.store.list(f.project.id, { query: "%" }).total, 1);
    for (const query of [
      '"',
      "'",
      "alpha OR",
      "NOT alpha",
      "NEAR(alpha beta)",
      "title:alpha",
      "*",
      "^alpha",
      'al"pha',
      "(",
      "-alpha",
      "\\",
      "alpha*",
      "{title content}: alpha",
      "AND",
    ])
      assert.doesNotThrow(() => f.store.list(f.project.id, { query }), query);
    const alphabet = ['"', "'", "%", "_", "*", "(", ")", ":", "^", "-", "+", " ", "a"];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...alphabet, "AND", "OR", "NOT", "NEAR"), {
          maxLength: 12,
        }),
        (parts) => {
          const result = f.store.list(f.project.id, { query: parts.join("") });
          assert.ok(result.total >= 0);
        },
      ),
      { seed: 91, numRuns: 200 },
    );
  });

  test(`${mode}: archived entries are only searched with the archived filter`, async (t) => {
    const f = await fixture(t, options);
    const [kept, gone] = seed(f.store, f.project.id, [
      ["Kept", "shared needle"],
      ["Gone", "shared needle"],
    ]);
    f.store.archive(f.project.id, gone.id, { expectedRevision: 1 });
    assert.deepEqual(titles(f.store.list(f.project.id, { query: "needle" })), ["Kept"]);
    assert.deepEqual(
      titles(f.store.list(f.project.id, { query: "needle", archived: true })),
      ["Gone"],
    );
    f.store.write(f.project.id, {
      id: kept.id,
      title: "Kept",
      content: "changed text",
      expectedRevision: 1,
    });
    assert.equal(f.store.list(f.project.id, { query: "needle" }).total, 0);
    assert.equal(f.store.list(f.project.id, { query: "changed" }).total, 1);
  });

  test(`${mode}: MCP search returns the GUI order with an excerpt around the match`, async (t) => {
    const f = await fixture(t, options);
    seed(f.store, f.project.id, [
      ["Long", `${"filler words ".repeat(60)}the rare marker sits here.`],
      ["Marker", "marker in the title too"],
    ]);
    issueCapability(f.store, {
      id: "search-session",
      account: { id: "account-1", tool: "codex" },
      projectId: f.project.id,
    });
    const credential = JSON.parse(
      fs.readFileSync(
        path.join(f.store.root, "sessions", "search-session", "capability.json"),
        "utf8",
      ),
    );
    const mcp = callMemoryTool(f.store, credential, "memory_search", {
      query: "marker",
    });
    const gui = f.store.list(f.project.id, { query: "marker" });
    assert.deepEqual(
      mcp.items.map((item) => item.id),
      gui.items.map((item) => item.id),
    );
    assert.deepEqual(titles(mcp), ["Marker", "Long"]);
    const long = mcp.items[1];
    assert.equal(long.content, undefined);
    assert.ok(Array.from(long.excerpt).length <= 256);
    assert.match(long.excerpt, /rare marker/);
  });

  test(`${mode}: search follows a project merge`, async (t) => {
    const f = await fixture(t, options);
    const target = await f.folder("target");
    seed(f.store, f.project.id, [["Moved", "travelling needle"]]);
    f.store.merge(f.project.id, f.store.scopeOf(target.id));
    assert.deepEqual(titles(f.store.list(target.id, { query: "needle" })), ["Moved"]);
  });
}

test("an unknown sort order is rejected", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.store.list(f.project.id, { query: "x", sort: "oldest" }), {
    status: 400,
  });
});

test("a missing or stale index is rebuilt at start", async (t) => {
  const f = await fixture(t);
  seed(f.store, f.project.id, [["Indexed", "first needle"]]);
  f.store.close();
  // Writes without the index (FTS5 unavailable) leave it stale for a later start.
  const plain = f.open({ fullTextSearch: false });
  seed(plain, f.project.id, [["Unindexed", "second needle"]]);
  plain.close();
  const reopened = f.open();
  assert.equal(reopened.list(f.project.id, { query: "needle" }).total, 2);
  reopened.db.exec("DROP TABLE memory_search");
  reopened.close();
  const rebuilt = f.open();
  assert.equal(rebuilt.list(f.project.id, { query: "second" }).total, 1);
  // An older release writes without updating the index; the next start notices.
  rebuilt.db.exec("DELETE FROM memory_search WHERE title='Indexed'");
  rebuilt.close();
  const repaired = f.open();
  assert.equal(repaired.list(f.project.id, { query: "first" }).total, 1);
  assert.equal(repaired.db.prepare("PRAGMA user_version").get().user_version, 1);
});

test("backups leave the derived index out and restore rebuilds it", async (t) => {
  const f = await fixture(t);
  seed(f.store, f.project.id, [["Backed up", "archived needle"]]);
  const scratch = fs.mkdtempSync(path.join(f.root, "scratch-"));
  const copy = sqliteSnapshotFile(path.join(f.store.root, "memory.sqlite"), scratch, {
    withoutCapabilities: true,
  });
  const db = new DatabaseSync(copy);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'memory_search%'")
      .get().n,
    0,
  );
  db.close();
  f.store.close();
  fs.copyFileSync(copy, path.join(f.dataDir, "memory", "memory.sqlite"));
  for (const suffix of ["-wal", "-shm"])
    fs.rmSync(path.join(f.dataDir, "memory", `memory.sqlite${suffix}`), { force: true });
  const restored = f.open();
  assert.equal(restored.list(f.project.id, { query: "needle" }).total, 1);
});
