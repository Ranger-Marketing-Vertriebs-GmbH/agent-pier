import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  installSkills,
  installed,
  skill,
  skillDir,
  update,
} from "../helpers/mcp-package-skills.js";
import { bundledSkills } from "../../server/features/mcp-packages/package-skill-scan.js";
import { npmPackageDirectory } from "../../server/features/mcp-packages/package-store.js";
import { writePrivate } from "../../server/lib/storage.js";

const recordsOf = (s) => s.extensions.installed();

test("an owner's edit inside a copy is kept on update and removal", async (t) => {
  const { s, server } = await installed(t);
  await installSkills(s, server.id);
  const guide = path.join(skillDir(s), "guide.md");
  fs.writeFileSync(guide, "My own notes.");
  await update(s, server.id, "2.0.0");
  assert.equal(fs.readFileSync(guide, "utf8"), "My own notes.");
  assert.doesNotMatch(
    fs.readFileSync(path.join(skillDir(s), "SKILL.md"), "utf8"),
    /version two/,
  );
  // No longer owned: the row shows it as the owner's, and removal leaves it alone.
  assert.deepEqual(recordsOf(s), []);
  const row = s.extensions
    .list("local-claude")
    .skills.items.find((item) => item.name === "reverse-it");
  assert.equal(row.removable, false);
  assert.equal(row.package, undefined);
  await s.changes.remove(server.id);
  assert.equal(fs.readFileSync(guide, "utf8"), "My own notes.");
});

test("a file the owner added to a copy keeps it on removal", async (t) => {
  const { s, server } = await installed(t);
  await installSkills(s, server.id);
  fs.writeFileSync(path.join(skillDir(s), "extra.md"), "added");
  await s.changes.remove(server.id);
  assert.equal(fs.existsSync(path.join(skillDir(s), "extra.md")), true);
  assert.deepEqual(recordsOf(s), []);
});

test("an install of several skills writes none when one target exists", async (t) => {
  const { s, server } = await installed(t);
  // The owner's own skill of the same name is never overwritten.
  fs.mkdirSync(skillDir(s, "second"), { recursive: true });
  fs.writeFileSync(path.join(skillDir(s, "second"), "SKILL.md"), "mine");
  await assert.rejects(installSkills(s, server.id, ["reverse-it", "second"]), {
    status: 409,
  });
  assert.equal(fs.existsSync(skillDir(s)), false);
  assert.equal(
    fs.readFileSync(path.join(skillDir(s, "second"), "SKILL.md"), "utf8"),
    "mine",
  );
  assert.deepEqual(recordsOf(s), []);
  await installSkills(s, server.id, ["reverse-it"]);
  // Installing a skill this package already owns in the profile again is a no-op.
  const listed = await installSkills(s, server.id, ["reverse-it"]);
  assert.equal(recordsOf(s).length, 1);
  assert.deepEqual(listed.skills.find((item) => item.name === "reverse-it").installed, [
    { profileId: "local-claude", version: "1.0.0" },
  ]);
});

test("a copy whose CLI profile is gone is released without touching it", async (t) => {
  const { s, server } = await installed(t);
  await installSkills(s, server.id);
  const records = recordsOf(s).map((item) => ({ ...item, accountId: "managed-gone" }));
  writePrivate(path.join(s.dataDir, "extension-skills.json"), records);
  await update(s, server.id, "2.0.0");
  assert.equal(s.servers.get(server.id).source.version, "2.0.0");
  assert.deepEqual(recordsOf(s), []);
  assert.equal(
    fs.readFileSync(path.join(skillDir(s), "guide.md"), "utf8"),
    "Read the binary first.",
  );
});

test("a failed swap restores the copy and keeps its record", async (t) => {
  const { s, server } = await installed(t);
  await installSkills(s, server.id);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (
      to === skillDir(s) &&
      path.basename(from).startsWith(".reverse-it-") &&
      !from.endsWith("-old")
    )
      throw Object.assign(Error("rename failed"), { code: "EIO" });
    return rename(from, to);
  });
  await update(s, server.id, "2.0.0");
  t.mock.restoreAll();
  assert.equal(
    fs.readFileSync(path.join(skillDir(s), "guide.md"), "utf8"),
    "Read the binary first.",
  );
  assert.equal(recordsOf(s)[0].package.version, "1.0.0");
  const parent = path.dirname(skillDir(s));
  assert.deepEqual(
    fs.readdirSync(parent).filter((name) => name.startsWith(".")),
    [],
  );
});

test("the listing reads metadata only; files are read when a skill is installed", async (t) => {
  const { s, server } = await installed(t);
  const row = s.servers.packages.get(server.id);
  const guide = path.join(
    npmPackageDirectory(s.dataDir, row),
    "skills",
    "reverse-it",
    "guide.md",
  );
  fs.chmodSync(guide, 0o000);
  t.after(() => fs.rmSync(guide, { force: true }));
  const listed = await s.packages.skills.list(server.id);
  assert.deepEqual(
    listed.skills.map((item) => item.name),
    ["reverse-it", "second"],
  );
  await assert.rejects(installSkills(s, server.id));
  assert.equal(fs.existsSync(skillDir(s)), false);
  assert.deepEqual(recordsOf(s), []);
});

test("skill files with several links are not offered", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-package-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "skills", "linked"), { recursive: true });
  fs.writeFileSync(path.join(root, "outside"), "secret");
  fs.writeFileSync(
    path.join(root, "skills", "linked", "SKILL.md"),
    skill("Hard linked.", "", "linked"),
  );
  fs.linkSync(
    path.join(root, "outside"),
    path.join(root, "skills", "linked", "notes.md"),
  );
  assert.deepEqual(await bundledSkills(root), []);
});

test("an install whose node_modules or scope is a link has no package folder", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-package-dir-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const installId = randomUUID();
  const install = path.join(dataDir, "mcp-packages", "installs", installId);
  const elsewhere = path.join(dataDir, "elsewhere");
  fs.mkdirSync(path.join(elsewhere, "@scope", "pkg"), { recursive: true });
  fs.mkdirSync(install, { recursive: true });
  writePrivate(path.join(install, "receipt.json"), { lockDigest: "d" });
  const row = { installId, lockDigest: "d", name: "@scope/pkg" };
  fs.symlinkSync(elsewhere, path.join(install, "node_modules"));
  assert.equal(npmPackageDirectory(dataDir, row), null);
  fs.unlinkSync(path.join(install, "node_modules"));
  fs.mkdirSync(path.join(install, "node_modules"));
  fs.symlinkSync(
    path.join(elsewhere, "@scope"),
    path.join(install, "node_modules", "@scope"),
  );
  assert.equal(npmPackageDirectory(dataDir, row), null);
  fs.unlinkSync(path.join(install, "node_modules", "@scope"));
  fs.mkdirSync(path.join(install, "node_modules", "@scope", "pkg"), { recursive: true });
  assert.equal(
    npmPackageDirectory(dataDir, row),
    path.join(install, "node_modules", "@scope", "pkg"),
  );
});
