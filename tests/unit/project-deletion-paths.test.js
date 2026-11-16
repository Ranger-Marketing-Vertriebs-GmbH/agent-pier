import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  folderState,
  inside,
  MOUNT_PARENTS,
  refusedFolder,
} from "../../server/features/projects/deletion-paths.js";

async function tree() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ap-del-paths-")));
  const home = path.join(base, "users", "me");
  const dataDir = path.join(base, "var", "data");
  const installDir = path.join(base, "opt", "install");
  for (const dir of [
    path.join(home, "Projects", "app"),
    path.join(dataDir, "x"),
    path.join(installDir, "y"),
  ]) {
    await mkdir(dir, { recursive: true });
  }
  return { base, home, dataDir, installDir };
}

const enoent = () => Object.assign(new Error("gone"), { code: "ENOENT" });

test("inside matches the folder itself and its descendants only", () => {
  assert.equal(inside("/a/b", "/a/b"), true);
  assert.equal(inside("/a/b", "/a/b/c"), true);
  assert.equal(inside("/a/b", "/a/bc"), false);
  assert.equal(inside("/a/b", "/a"), false);
});

test("refuses root, home, its parents and its direct children", async () => {
  const t = await tree();
  const o = { home: t.home, dataDir: t.dataDir, installDir: t.installDir };
  assert.equal(await refusedFolder("/", o), "root");
  assert.equal(await refusedFolder(t.home, o), "home");
  assert.equal(await refusedFolder(path.dirname(t.home), o), "home-parent");
  assert.equal(await refusedFolder(path.join(t.home, "Projects"), o), "home-child");
  assert.equal(await refusedFolder(path.join(t.home, "Projects", "app"), o), null);
  await rm(t.base, { recursive: true, force: true });
});

test("refuses the data dir, the install dir, anything inside or containing them", async () => {
  const t = await tree();
  const o = { home: t.home, dataDir: t.dataDir, installDir: t.installDir };
  for (const own of [t.dataDir, t.installDir]) {
    assert.equal(await refusedFolder(own, o), "agentpier");
    assert.equal(
      await refusedFolder(path.join(own, own === t.dataDir ? "x" : "y"), o),
      "agentpier",
    );
  }
  // A folder that contains the data dir.
  assert.equal(await refusedFolder(path.dirname(t.dataDir), o), "agentpier");
  assert.equal(await refusedFolder(path.dirname(t.installDir), o), "agentpier");
  await rm(t.base, { recursive: true, force: true });
});

test("refuses a link, a file and a mount point", async () => {
  const t = await tree();
  const o = { home: t.home, dataDir: t.dataDir, installDir: t.installDir };
  const real = path.join(t.home, "Projects", "app");
  const link = path.join(t.home, "Projects", "link");
  await symlink(real, link);
  assert.equal(await refusedFolder(link, o), "symlink");
  const file = path.join(real, "f.txt");
  await writeFile(file, "x");
  assert.equal(await refusedFolder(file, o), "not-directory");
  const stat = async (p) => ({ dev: p === real ? 2 : 1 });
  assert.equal(await refusedFolder(real, { ...o, stat }), "mount-point");
  await rm(t.base, { recursive: true, force: true });
});

test("refuses a folder reached through a link", async () => {
  const t = await tree();
  const o = { home: t.home, dataDir: t.dataDir, installDir: t.installDir };
  const viaLink = path.join(t.base, "alias");
  await symlink(path.join(t.home, "Projects"), viaLink);
  assert.equal(await refusedFolder(path.join(viaLink, "app"), o), "symlink");
  await rm(t.base, { recursive: true, force: true });
});

test("refuses the home folder reached through a link", async () => {
  const t = await tree();
  const homeLink = path.join(t.base, "home-link");
  await symlink(t.home, homeLink);
  const o = { home: homeLink, dataDir: t.dataDir, installDir: t.installDir };
  assert.equal(await refusedFolder(t.home, o), "home");
  assert.equal(await refusedFolder(path.join(t.home, "Projects"), o), "home-child");
  await rm(t.base, { recursive: true, force: true });
});

test("folder state: present, missing, unavailable", async () => {
  const t = await tree();
  const existing = path.join(t.home, "Projects", "app");
  assert.equal(await folderState(existing), "present");
  assert.equal(await folderState(path.join(existing, "gone")), "missing");
  const fakeNoVolumes = async (p) => {
    if (p === "/Volumes" || p === "/") return {};
    throw enoent();
  };
  assert.equal(
    await folderState("/Volumes/Unplugged/app", { stat: fakeNoVolumes }),
    "unavailable",
  );
  const mounted = async (p) => {
    if (p === "/Volumes" || p === "/Volumes/Disk" || p === "/") return {};
    throw enoent();
  };
  assert.equal(await folderState("/Volumes/Disk/app", { stat: mounted }), "missing");
  const eioStat = async () => {
    throw Object.assign(new Error("io"), { code: "EIO" });
  };
  assert.equal(await folderState("/net/share/app", { stat: eioStat }), "unavailable");
  const never = () => new Promise(() => {});
  assert.equal(
    await folderState("/slow/app", { stat: never, timeoutMs: 50 }),
    "unavailable",
  );
  assert.ok(MOUNT_PARENTS.every((re) => re instanceof RegExp));
  await rm(t.base, { recursive: true, force: true });
});
