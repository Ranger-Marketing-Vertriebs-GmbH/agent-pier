import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deletionScope } from "../../server/application/project-deletion-scope.js";
import { refusedFolder } from "../../server/features/projects/deletion-paths.js";
import {
  parseMountinfo,
  parseMountOutput,
  readMountPoints,
} from "../../server/features/projects/mount-table.js";
import { quietLog, setup } from "../helpers/project-deletion.js";

test("reads Linux mountinfo with escaped spaces, tabs and newlines", () => {
  const text = [
    "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
    "40 22 0:35 / /home/me/My\\040Drive rw - fuse sshfs rw",
    "41 22 0:36 / /mnt/odd\\012name\\011x rw - tmpfs tmpfs rw",
    "",
  ].join("\n");
  assert.deepEqual(parseMountinfo(text), ["/", "/home/me/My Drive", "/mnt/odd\nname\tx"]);
  assert.throws(() => parseMountinfo("garbage"));
});

test("reads macOS mount output; a line it cannot read fails the table", () => {
  const text = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
    "/dev/disk5s1 on /Users/me/Work (x)/disk on (y) (apfs, local, nodev)",
    "//me@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by me)",
  ].join("\n");
  assert.deepEqual(parseMountOutput(text), [
    "/",
    "/System/Volumes/Data/home",
    "/Users/me/Work (x)/disk on (y)",
    "/Volumes/share",
  ]);
  // A mount point with a newline splits its line: unreadable, never skipped.
  assert.throws(() => parseMountOutput(`${text}\nname (apfs)`));
});

test("lists firmlinked data volume mounts by both paths; other systems throw", async () => {
  const run = async () =>
    "/dev/disk3s5 on /System/Volumes/Data/Users/me/app/disk (apfs, local)\n";
  assert.deepEqual(await readMountPoints({ platform: "darwin", run }), [
    "/System/Volumes/Data/Users/me/app/disk",
    "/Users/me/app/disk",
  ]);
  const read = async (file) => {
    assert.equal(file, "/proc/self/mountinfo");
    return "1 0 0:1 / /srv/app/data rw - ext4 /dev/sdb rw\n";
  };
  assert.deepEqual(await readMountPoints({ platform: "linux", read }), ["/srv/app/data"]);
  await assert.rejects(readMountPoints({ platform: "win32" }));
  await assert.rejects(
    readMountPoints({
      platform: "darwin",
      run: async () => {
        throw Object.assign(new Error("timed out"), { killed: true });
      },
    }),
  );
});

test("refuses a folder with a drive mounted inside it, or an unreadable table", async (t) => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "ap-del-mounts-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const app = path.join(base, "work", "app");
  await mkdir(path.join(app, "disk"), { recursive: true });
  const options = (mounts) => ({
    home: path.join(base, "home"),
    dataDir: path.join(base, "data"),
    installDir: path.join(base, "install"),
    mounts,
  });
  const table = (points) => async () => ["/", ...points];
  assert.equal(await refusedFolder(app, options(table([]))), null);
  assert.equal(
    await refusedFolder(app, options(table([path.join(app, "disk")]))),
    "contains-mount",
  );
  assert.equal(
    await refusedFolder(app, options(table([path.join(app, "a", "b")]))),
    "contains-mount",
  );
  assert.equal(await refusedFolder(app, options(table([app]))), "mount-point");
  // Beside the folder, or a name that only starts the same way: not inside.
  assert.equal(await refusedFolder(app, options(table([`${app}-two`]))), null);
  const failing = async () => {
    throw new Error("mount failed");
  };
  assert.equal(await refusedFolder(app, options(failing)), "mounts-unreadable");
});

test("a drive mounted after the check stops the deletion right before rm", async (t) => {
  quietLog(t);
  const f = await setup(t);
  // A deletion recorded after its checks, as start() leaves it.
  const scope = await deletionScope(f.services, f.app);
  f.memory.deletions.mark(scope.path, {
    ...scope,
    folderMissing: false,
    nested: [],
    report: { unsavedGitWork: false, endedSessionIds: [], endedProcesses: [] },
  });
  // Meanwhile a drive got mounted at src inside the folder.
  const check = f.deletion.probes.refusedFolder;
  f.deletion.probes.refusedFolder = (folder, options) =>
    check(folder, { ...options, mounts: async () => ["/", path.join(f.app, "src")] });
  await f.deletion.resume();
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app).error, "PROJECT_DELETE_REFUSED");
  assert.equal(fs.existsSync(path.join(f.app, "src", "index.js")), true);
  assert.equal(f.memory.hasProject(f.id), true);
});
