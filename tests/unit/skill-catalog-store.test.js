import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SkillCatalogStore } from "../../server/features/skill-catalog/catalog-store.js";
import { skillDigest } from "../../server/features/extensions/skill-digest.js";
import { writeSkillFiles } from "../../server/features/extensions/skill-files.js";

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-catalog-store-"));
});
afterEach(() => {
  mock.restoreAll();
  fs.rmSync(root, { recursive: true, force: true });
});

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
const meta = (extra = {}) => ({
  importKind: "upload",
  scan: { verdict: "clean", rules: [], overridden: false },
  needsSettings: false,
  ...extra,
});
const mode = (file) => fs.statSync(file).mode & 0o777;
function eachFile(dir, fn) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) eachFile(file, fn);
    else fn(file);
  }
}

test("a new skill is stored once and copied live read-only", () => {
  const s = new SkillCatalogStore({ root });
  const r = s.write(pack("probe", "v1", { "run.sh": 0o700 }), meta());
  assert.equal(r.version, 1);
  assert.equal(s.liveRoot, path.join(root, "skills"));
  assert.ok(fs.existsSync(path.join(root, "store/probe", r.digest, "SKILL.md")));
  assert.equal(mode(path.join(s.liveRoot, "probe/SKILL.md")), 0o400);
  assert.equal(mode(path.join(s.liveRoot, "probe/run.sh")), 0o500);
  assert.equal(mode(path.join(root, "store/probe", r.digest, "run.sh")), 0o500);
  assert.deepEqual(r.executables, ["run.sh"]);
  assert.equal(r.digest, skillDigest(path.join(s.liveRoot, "probe"), { modes: false }));
  assert.deepEqual(s.byName("probe"), r);
  assert.deepEqual(s.byId(r.id), r);
  assert.deepEqual([...s.names()], ["probe"]);
  assert.equal(new SkillCatalogStore({ root }).list().length, 1);
  assert.equal(mode(path.join(root, "catalog.json")), 0o600);
});

test("the same name becomes the next version and the old one leaves the store", () => {
  const s = new SkillCatalogStore({ root });
  const v1 = s.write(pack("probe", "v1"), meta());
  const v2 = s.write(pack("probe", "v2"), meta());
  assert.equal(v2.id, v1.id);
  assert.equal(v2.version, 2);
  assert.equal(v2.installedAt, v1.installedAt);
  assert.ok(!fs.existsSync(path.join(root, "store/probe", v1.digest)));
  assert.match(fs.readFileSync(path.join(s.liveRoot, "probe/SKILL.md"), "utf8"), /v2/);
  assert.deepEqual(fs.readdirSync(s.liveRoot), ["probe"]); // nothing else scanned
  assert.deepEqual(fs.readdirSync(path.join(root, "staging")), []);
  assert.equal(s.list().length, 1);
});

test("an unchanged rewrite reuses the stored version", () => {
  const s = new SkillCatalogStore({ root });
  const v1 = s.write(pack("probe", "v1"), meta());
  const again = s.write(pack("probe", "v1"), meta());
  assert.equal(again.version, 2);
  assert.equal(again.digest, v1.digest);
  assert.ok(fs.existsSync(path.join(root, "store/probe", v1.digest, "SKILL.md")));
  assert.match(fs.readFileSync(path.join(s.liveRoot, "probe/SKILL.md"), "utf8"), /v1/);
});

test("an invalid skill name is refused before anything is written", () => {
  const s = new SkillCatalogStore({ root });
  for (const name of ["../escape", "a/b", "Upper", ""])
    assert.throws(() => s.write(pack(name, "v1"), meta()), { status: 400 });
  assert.equal(s.list().length, 0);
  assert.ok(!fs.existsSync(path.join(root, "escape")));
});

test("a pack with an unsafe path fails before the swap and leaves the old version live", () => {
  const s = new SkillCatalogStore({ root });
  const v1 = s.write(pack("probe", "v1"), meta());
  const bad = pack("probe", "v2");
  bad.files.push(["../outside.txt", Buffer.from("x"), 0o644]);
  assert.throws(() => s.write(bad, meta()));
  assert.match(fs.readFileSync(path.join(s.liveRoot, "probe/SKILL.md"), "utf8"), /v1/);
  assert.equal(s.byName("probe").version, 1);
  assert.ok(!fs.existsSync(path.join(root, "outside.txt")));
  s.sweep();
  assert.deepEqual(fs.readdirSync(path.join(root, "staging")), []);
  assert.deepEqual(fs.readdirSync(path.join(root, "store/probe")), [v1.digest]);
});

test("a failed rename into the live root restores the old copy and a retry works", () => {
  const s = new SkillCatalogStore({ root });
  s.write(pack("probe", "v1"), meta());
  const live = path.join(s.liveRoot, "probe");
  const rename = fs.renameSync;
  mock.method(fs, "renameSync", (from, to) => {
    if (to === live && !from.endsWith("-old")) throw new Error("disk full");
    return rename(from, to);
  });
  assert.throws(() => s.write(pack("probe", "v2"), meta()));
  mock.restoreAll();
  assert.match(fs.readFileSync(path.join(live, "SKILL.md"), "utf8"), /v1/);
  assert.deepEqual(fs.readdirSync(s.liveRoot), ["probe"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "staging")), []);
  assert.equal(s.byName("probe").version, 1);
  assert.equal(fs.readdirSync(path.join(root, "store/probe")).length, 1);
  const retry = s.write(pack("probe", "v2"), meta());
  assert.equal(retry.version, 2);
  assert.match(fs.readFileSync(path.join(live, "SKILL.md"), "utf8"), /v2/);
});

test("a crash after the live copy moved aside is restored from the store", () => {
  const s = new SkillCatalogStore({ root });
  s.write(pack("probe", "v1"), meta());
  // The process died between moving the live copy aside and renaming the new one in.
  fs.renameSync(path.join(s.liveRoot, "probe"), path.join(root, "staging/crash-old"));
  fs.mkdirSync(path.join(root, "staging/crash-new"));
  assert.deepEqual(s.verify(), { restored: ["probe"], damaged: [], failed: [] });
  assert.match(fs.readFileSync(path.join(s.liveRoot, "probe/SKILL.md"), "utf8"), /v1/);
  s.sweep();
  assert.deepEqual(fs.readdirSync(path.join(root, "staging")), []);
});

test("verify restores an edited live copy from the store", () => {
  const s = new SkillCatalogStore({ root });
  s.write(pack("probe", "v1", { "run.sh": 0o755 }), meta());
  const file = path.join(s.liveRoot, "probe/SKILL.md");
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, "tampered");
  fs.writeFileSync(path.join(s.liveRoot, "probe/extra.md"), "added");
  assert.deepEqual(s.verify(["probe"]), { restored: ["probe"], damaged: [], failed: [] });
  assert.match(fs.readFileSync(file, "utf8"), /v1/);
  assert.equal(mode(file), 0o400);
  assert.equal(mode(path.join(s.liveRoot, "probe/run.sh")), 0o500);
  assert.ok(!fs.existsSync(path.join(s.liveRoot, "probe/extra.md")));
  assert.deepEqual(fs.readdirSync(s.liveRoot), ["probe"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "staging")), []);
});

test("verify only re-applies modes after a 0600 restore", () => {
  const s = new SkillCatalogStore({ root });
  const r = s.write(pack("probe", "v1", { "bin/run.sh": 0o755 }), meta());
  const live = path.join(s.liveRoot, "probe");
  const store = path.join(root, "store/probe", r.digest);
  for (const dir of [live, store]) eachFile(dir, (file) => fs.chmodSync(file, 0o600));
  const inode = fs.statSync(path.join(live, "SKILL.md")).ino;
  assert.deepEqual(s.verify(), { restored: [], damaged: [], failed: [] });
  assert.equal(fs.statSync(path.join(live, "SKILL.md")).ino, inode); // not re-copied
  for (const dir of [live, store]) {
    assert.equal(mode(path.join(dir, "bin/run.sh")), 0o500);
    assert.equal(mode(path.join(dir, "SKILL.md")), 0o400);
    assert.equal(mode(path.join(dir, "bin")), 0o700);
  }
  assert.equal(s.byName("probe").damaged, undefined);
});

test("a damaged store copy removes the live copy and marks the record", () => {
  const s = new SkillCatalogStore({ root });
  const r = s.write(pack("probe", "v1"), meta());
  for (const dir of [
    path.join(s.liveRoot, "probe"),
    path.join(root, "store/probe", r.digest),
  ]) {
    const file = path.join(dir, "SKILL.md");
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, "tampered");
  }
  assert.deepEqual(s.verify(["probe"]), { restored: [], damaged: ["probe"], failed: [] });
  assert.ok(!fs.existsSync(path.join(s.liveRoot, "probe")));
  assert.equal(s.byName("probe").damaged, true);
  assert.equal(new SkillCatalogStore({ root }).byName("probe").damaged, true);
  assert.deepEqual(s.dropped(["probe"]), ["probe"]);
  // A damaged skill stays damaged and is not reported again.
  assert.deepEqual(s.verify(), { restored: [], damaged: [], failed: [] });
  // Installing it again clears the mark.
  const again = s.write(pack("probe", "v1"), meta());
  assert.equal(again.damaged, undefined);
  assert.deepEqual(s.verify(), { restored: [], damaged: [], failed: [] });
});

test("an intact live copy repairs a changed store copy", () => {
  const s = new SkillCatalogStore({ root });
  const r = s.write(pack("probe", "v1", { "run.sh": 0o755 }), meta());
  const stored = path.join(root, "store/probe", r.digest, "SKILL.md");
  fs.chmodSync(stored, 0o600);
  fs.writeFileSync(stored, "tampered");
  assert.deepEqual(s.verify(), { restored: [], damaged: [], failed: [] });
  assert.match(fs.readFileSync(stored, "utf8"), /v1/);
  assert.equal(mode(path.join(root, "store/probe", r.digest, "run.sh")), 0o500);
  assert.deepEqual(fs.readdirSync(path.join(root, "staging")), []);
});

test("a missing store copy marks the record damaged", () => {
  const s = new SkillCatalogStore({ root });
  const r = s.write(pack("probe", "v1"), meta());
  fs.rmSync(path.join(root, "store/probe", r.digest), { recursive: true });
  fs.rmSync(path.join(s.liveRoot, "probe"), { recursive: true });
  assert.deepEqual(s.verify(["probe"]), { restored: [], damaged: ["probe"], failed: [] });
});

test("dropped names bundled, needsSettings and damaged catalog skills only", () => {
  const s = new SkillCatalogStore({ root });
  s.write(pack("probe", "v1"), meta());
  s.write(pack("envy", "v1"), meta({ needsSettings: true }));
  s.write(pack("calm", "v1"), meta());
  assert.deepEqual(s.dropped(["probe", "github", "envy", "calm"], new Set(["probe"])), [
    "envy",
    "probe",
  ]);
  assert.deepEqual(s.dropped(["github"], new Set(["github"])), []);
});

test("sweep removes staging leftovers, unreferenced versions and unknown live folders", () => {
  const s = new SkillCatalogStore({ root });
  const r = s.write(pack("probe", "v1"), meta());
  writeSkillFiles(path.join(root, "staging/leftover"), pack("probe", "x").files, {
    readOnly: true,
  });
  writeSkillFiles(path.join(root, "store/probe/stale"), pack("probe", "x").files, {
    readOnly: true,
  });
  writeSkillFiles(path.join(root, "store/ghost/abc"), pack("ghost", "x").files);
  writeSkillFiles(path.join(s.liveRoot, "ghost"), pack("ghost", "x").files);
  fs.writeFileSync(path.join(s.liveRoot, "stray.md"), "x");
  const outside = path.join(root, "keep.txt");
  fs.writeFileSync(outside, "keep");
  s.sweep();
  assert.deepEqual(fs.readdirSync(path.join(root, "staging")), []);
  assert.deepEqual(fs.readdirSync(path.join(root, "store")), ["probe"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "store/probe")), [r.digest]);
  assert.deepEqual(fs.readdirSync(s.liveRoot), ["probe"]);
  assert.ok(fs.existsSync(outside));
});

test("remove deletes live, store and record", () => {
  const s = new SkillCatalogStore({ root });
  const r = s.write(pack("probe", "v1", { "run.sh": 0o755 }), meta());
  s.write(pack("other", "v1"), meta());
  const removed = s.remove(r.id);
  assert.equal(removed.id, r.id);
  assert.ok(!fs.existsSync(path.join(s.liveRoot, "probe")));
  assert.ok(!fs.existsSync(path.join(root, "store/probe")));
  assert.equal(s.byId(r.id), undefined);
  assert.deepEqual([...s.names()], ["other"]);
  assert.throws(() => s.remove(r.id), { status: 404 });
});

test("skillDigest without modes ignores permission bits only", () => {
  const dir = path.join(root, "d");
  writeSkillFiles(dir, pack("probe", "v1", { "run.sh": 0o755 }).files);
  const withModes = skillDigest(dir);
  const without = skillDigest(dir, { modes: false });
  fs.chmodSync(path.join(dir, "run.sh"), 0o600);
  assert.notEqual(skillDigest(dir), withModes);
  assert.equal(skillDigest(dir, { modes: false }), without);
  fs.writeFileSync(path.join(dir, "run.sh"), "changed");
  assert.notEqual(skillDigest(dir, { modes: false }), without);
});

test("writeSkillFiles writes read-only copies on request", () => {
  const dir = path.join(root, "w");
  writeSkillFiles(dir, pack("probe", "v1", { "run.sh": 0o744, "a/b.txt": 0o644 }).files, {
    readOnly: true,
  });
  assert.equal(mode(path.join(dir, "SKILL.md")), 0o400);
  assert.equal(mode(path.join(dir, "run.sh")), 0o500);
  assert.equal(mode(path.join(dir, "a/b.txt")), 0o400);
  assert.throws(() =>
    writeSkillFiles(path.join(root, "x"), [["../y", Buffer.from("x"), 0o644]]),
  );
});

test("a symlinked live folder is replaced and the other skills are still verified", () => {
  const s = new SkillCatalogStore({ root });
  s.write(pack("alpha", "v1"), meta());
  s.write(pack("probe", "v1"), meta());
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "skill-catalog-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    const live = path.join(s.liveRoot, "alpha");
    fs.rmSync(live, { recursive: true });
    fs.symlinkSync(outside, live);
    const probe = path.join(s.liveRoot, "probe/SKILL.md");
    fs.chmodSync(probe, 0o600);
    fs.writeFileSync(probe, "tampered");
    assert.deepEqual(s.verify(), {
      restored: ["alpha", "probe"],
      damaged: [],
      failed: [],
    });
    assert.ok(!fs.lstatSync(live).isSymbolicLink());
    assert.match(fs.readFileSync(path.join(live, "SKILL.md"), "utf8"), /v1/);
    assert.match(fs.readFileSync(probe, "utf8"), /v1/);
    assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
    // A write of the same name works too.
    fs.rmSync(live, { recursive: true });
    fs.symlinkSync(outside, live);
    assert.equal(s.write(pack("alpha", "v2"), meta()).version, 2);
    assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlinked store version is replaced from the intact live copy", () => {
  const s = new SkillCatalogStore({ root });
  const r = s.write(pack("probe", "v1"), meta());
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "skill-catalog-outside-"));
  try {
    const stored = path.join(root, "store/probe", r.digest);
    fs.rmSync(stored, { recursive: true });
    fs.symlinkSync(outside, stored);
    assert.deepEqual(s.verify(), { restored: [], damaged: [], failed: [] });
    assert.ok(!fs.lstatSync(stored).isSymbolicLink());
    assert.match(fs.readFileSync(path.join(stored, "SKILL.md"), "utf8"), /v1/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("sweep removes planted links without touching their targets", () => {
  const s = new SkillCatalogStore({ root });
  s.write(pack("probe", "v1"), meta());
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "skill-catalog-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    fs.symlinkSync(outside, path.join(root, "staging/link"));
    fs.symlinkSync(outside, path.join(s.liveRoot, "ghost"));
    fs.symlinkSync(outside, path.join(root, "store/ghost"));
    s.sweep();
    assert.deepEqual(fs.readdirSync(path.join(root, "staging")), []);
    assert.deepEqual(fs.readdirSync(s.liveRoot), ["probe"]);
    assert.deepEqual(fs.readdirSync(path.join(root, "store")), ["probe"]);
    assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
    // A link in place of a whole sub-root is removed, never followed.
    fs.rmSync(path.join(root, "staging"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "staging"));
    s.sweep();
    assert.ok(fs.lstatSync(path.join(root, "staging")).isDirectory());
    assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

for (const method of ["renameSync", "writeFileSync"])
  test(`a failing ${method} during a store repair keeps the live copy`, () => {
    const s = new SkillCatalogStore({ root });
    const r = s.write(pack("probe", "v1"), meta());
    const stored = path.join(root, "store/probe", r.digest, "SKILL.md");
    fs.chmodSync(stored, 0o600);
    fs.writeFileSync(stored, "tampered");
    mock.method(fs, method, () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    assert.deepEqual(s.verify(), { restored: [], damaged: [], failed: ["probe"] });
    mock.restoreAll();
    // The live copy was intact: it stays, and the name is dropped until a verify passes.
    assert.match(fs.readFileSync(path.join(s.liveRoot, "probe/SKILL.md"), "utf8"), /v1/);
    assert.equal(s.byName("probe").damaged, undefined);
    assert.deepEqual(s.dropped(["probe"]), ["probe"]);
    assert.deepEqual(s.verify(), { restored: [], damaged: [], failed: [] });
    assert.match(fs.readFileSync(stored, "utf8"), /v1/);
  });

test("a tampered live copy that could not be restored leaves skills/ and is restored next", () => {
  const s = new SkillCatalogStore({ root });
  s.write(pack("probe", "v1"), meta());
  const file = path.join(s.liveRoot, "probe/SKILL.md");
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, "tampered");
  const rename = fs.renameSync;
  // Only the swap fails; the catalog file could still be written.
  mock.method(fs, "renameSync", (from, to) => {
    if (String(to).endsWith(".json")) return rename(from, to);
    throw Object.assign(new Error("EIO"), { code: "EIO" });
  });
  assert.deepEqual(s.verify(), { restored: [], damaged: [], failed: ["probe"] });
  mock.restoreAll();
  // OpenClaw can no longer load the tampered copy; the store copy is kept.
  assert.deepEqual(fs.readdirSync(s.liveRoot), []);
  assert.equal(s.byName("probe").damaged, undefined);
  assert.deepEqual(s.dropped(["probe"]), ["probe"]);
  assert.deepEqual(s.verify(), { restored: ["probe"], damaged: [], failed: [] });
  assert.match(fs.readFileSync(file, "utf8"), /v1/);
  assert.deepEqual(s.dropped(["probe"]), []);
});

test("a tampered store folder without write permission is still replaced", () => {
  const s = new SkillCatalogStore({ root });
  const r = s.write(pack("probe", "v1"), meta());
  const stored = path.join(root, "store/probe", r.digest);
  fs.chmodSync(path.join(stored, "SKILL.md"), 0o600);
  fs.writeFileSync(path.join(stored, "SKILL.md"), "tampered");
  fs.chmodSync(stored, 0o500);
  assert.deepEqual(s.verify(), { restored: [], damaged: [], failed: [] });
  assert.match(fs.readFileSync(path.join(stored, "SKILL.md"), "utf8"), /v1/);
  fs.chmodSync(stored, 0o500);
  s.write(pack("probe", "v2"), meta());
  assert.ok(!fs.existsSync(stored));
});
