import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { loadArchive } from "../helpers/backup-archive.js";
import {
  captureAssistants,
  isAssistantMember,
  isLegacyAssistantCache,
} from "../../server/features/operations/assistant-backup.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { SkillCatalogStore } from "../../server/features/skill-catalog/catalog-store.js";

const catalog = "assistants/skill-catalog";

function fixture(t) {
  const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "skill-catalog-backup-")),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const dataDir = path.join(temporary, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const root = path.join(dataDir, "assistants");
  const store = new AssistantStore({ dataDir });
  store.db
    .prepare("INSERT INTO assistants VALUES (?,?,?)")
    .run(
      "home",
      1,
      JSON.stringify({ id: "home", name: "Home", skills: ["redis-cache"] }),
    );
  store.close();
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ enabled: true }), {
    mode: 0o600,
  });
  return { temporary, dataDir, root };
}
function pack(name, marker, extra = {}) {
  const files = [
    [
      "SKILL.md",
      Buffer.from(`---\nname: ${name}\ndescription: ${marker}\n---\n${marker}\n`),
      0o644,
    ],
  ];
  for (const [file, mode] of Object.entries(extra))
    files.push([file, Buffer.from(`echo ${marker}\n`), mode]);
  return { name, description: marker, files };
}
const meta = () => ({
  importKind: "upload",
  scan: { verdict: "clean", rules: [], overridden: false },
  needsSettings: false,
});
const mode = (file) => fs.statSync(file).mode & 0o777;
function catalogStore(dataDir) {
  return new SkillCatalogStore({ root: runtimePaths(dataDir).skillCatalog });
}
function storedSkills(root) {
  const db = new DatabaseSync(path.join(root, "assistants.sqlite"), { readOnly: true });
  try {
    return JSON.parse(
      db.prepare("SELECT body FROM assistants WHERE id = 'home'").get().body,
    ).skills;
  } finally {
    db.close();
  }
}

test("a backup carries the catalog, and the restore verifies without damage", async (t) => {
  const { temporary, dataDir, root } = fixture(t);
  const record = catalogStore(dataDir).write(
    pack("redis-cache", "v1", {
      "node_modules/x/run.sh": 0o700,
      "cache/notes.md": 0o600,
    }),
    meta(),
  );
  // A leftover of an interrupted swap.
  const staged = path.join(root, "skill-catalog/staging/left-over/SKILL.md");
  fs.mkdirSync(path.dirname(staged), { recursive: true, mode: 0o700 });
  fs.writeFileSync(staged, "half-written", { mode: 0o600 });

  const backup = await new Backup({ dataDir }).create();
  const names = loadArchive(backup.file).files.map((member) => member.path);
  for (const expected of [
    `${catalog}/catalog.json`,
    `${catalog}/store/redis-cache/${record.digest}/SKILL.md`,
    `${catalog}/store/redis-cache/${record.digest}/node_modules/x/run.sh`,
    `${catalog}/store/redis-cache/${record.digest}/cache/notes.md`,
    `${catalog}/skills/redis-cache/SKILL.md`,
    `${catalog}/skills/redis-cache/node_modules/x/run.sh`,
    `${catalog}/skills/redis-cache/cache/notes.md`,
  ])
    assert.ok(names.includes(expected), expected);
  assert.equal(
    names.some((name) => name.startsWith(`${catalog}/staging/`)),
    false,
    names.join("\n"),
  );

  const target = path.join(temporary, "restored");
  await new Restore({ dataDir }).apply({ archive: backup.file, targetDataDir: target });
  const live = path.join(target, "assistants/skill-catalog/skills/redis-cache");
  // A restore writes every file as 0600.
  assert.equal(mode(path.join(live, "node_modules/x/run.sh")), 0o600);
  const restoredCatalog = catalogStore(target);
  assert.deepEqual(restoredCatalog.verify(), { restored: [], damaged: [], failed: [] });
  assert.equal(mode(path.join(live, "node_modules/x/run.sh")), 0o500);
  assert.equal(mode(path.join(live, "SKILL.md")), 0o400);
  assert.equal(fs.readFileSync(path.join(live, "cache/notes.md"), "utf8"), "echo v1\n");
  assert.deepEqual([...restoredCatalog.names()], ["redis-cache"]);
  assert.deepEqual(storedSkills(path.join(target, "assistants")), ["redis-cache"]);
});

test("host captures keep cache-named catalog folders and never staging", async (t) => {
  const { dataDir } = fixture(t);
  catalogStore(dataDir).write(pack("redis-cache", "v1", { "cache/a.md": 0o600 }), meta());
  const staged = path.join(dataDir, "assistants/skill-catalog/staging/x/node_modules/y");
  fs.mkdirSync(path.dirname(staged), { recursive: true, mode: 0o700 });
  fs.writeFileSync(staged, "staged", { mode: 0o600 });
  const result = await captureAssistants({
    dataDir,
    id: "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e03",
    withCredentials: false,
    includeHistory: false,
  });
  const names = result.files.map((member) => member.path);
  assert.ok(names.includes(`${catalog}/skills/redis-cache/cache/a.md`), names.join("\n"));
  assert.equal(
    names.some((name) => name.startsWith(`${catalog}/staging/`)),
    false,
  );
  // Restores accept catalog members of any folder name and never as a legacy cache.
  for (const name of [
    `${catalog}/skills/redis-cache/cache/a.md`,
    `${catalog}/store/redis-cache/abc/node_modules/x/run.sh`,
    `${catalog}/skills/web-cache/Code Cache/x`,
  ]) {
    assert.equal(isAssistantMember(name), true, name);
    assert.equal(isLegacyAssistantCache(name), false, name);
  }
  assert.equal(isAssistantMember(`${catalog}/staging/x/SKILL.md`), false);
});

test("a backup taken before the catalog existed still restores", async (t) => {
  const { temporary, dataDir } = fixture(t);
  const backup = await new Backup({ dataDir }).create();
  const names = loadArchive(backup.file).files.map((member) => member.path);
  assert.equal(
    names.some((name) => name.startsWith(`${catalog}/`)),
    false,
  );
  const target = path.join(temporary, "restored");
  await new Restore({ dataDir }).apply({ archive: backup.file, targetDataDir: target });
  const restoredCatalog = catalogStore(target);
  assert.deepEqual(restoredCatalog.list(), []);
  assert.deepEqual(restoredCatalog.verify(), { restored: [], damaged: [], failed: [] });
  // The stored switch outlives a missing catalog; the compile drops the name.
  assert.deepEqual(storedSkills(path.join(target, "assistants")), ["redis-cache"]);
});
