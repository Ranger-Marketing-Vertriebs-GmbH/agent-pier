import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listFolder,
  searchFolder,
} from "../../server/features/assistants/project-files.js";
import { inFolder } from "../../server/features/assistants/project-open.js";
import {
  localRoot,
  removeLocal,
  walkLocal,
} from "../../server/features/sftp/sftp-local.js";

// A process that can change the project folder swaps a folder for a link to an
// outside folder after the folder was checked and opened, right before an entry in it
// is looked at, read or removed. Linux acts through the opened folder
// (/proc/self/fd), so nothing outside is touched and the call succeeds inside; macOS
// sees the changed folder identity and refuses. Neither deletes or lists outside.
const linux = process.platform !== "darwin";

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folder-race-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  const sub = path.join(root, "sub");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(sub, "empty"), { recursive: true });
  fs.mkdirSync(path.join(outside, "empty"), { recursive: true });
  fs.writeFileSync(path.join(sub, "notes.txt"), "inside\n");
  fs.writeFileSync(path.join(outside, "notes.txt"), "secret\n");
  fs.writeFileSync(path.join(outside, "outside-only.txt"), "secret\n");
  return { root, sub, outside, moved: `${sub}.moved` };
}

// Swaps `sub` for a link to `outside` on the `nth` call of fs.promises[method] whose
// first argument passes `match`, before that call runs. The swap stays until the
// returned restore runs, so a check after the call still sees it.
function swapOn(
  t,
  { sub, outside, moved },
  method,
  { nth = 1, match = () => true } = {},
) {
  let calls = 0;
  let swapped = false;
  const real = fs.promises[method];
  t.mock.method(fs.promises, method, async (file, ...rest) => {
    if (!swapped && match(String(file)) && ++calls === nth) {
      fs.renameSync(sub, moved);
      fs.symlinkSync(outside, sub);
      swapped = true;
    }
    return real(file, ...rest);
  });
  return () => {
    t.mock.restoreAll();
    if (!swapped) return false;
    fs.unlinkSync(sub);
    fs.renameSync(moved, sub);
    return true;
  };
}

async function settle(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

const refused = (error) => error?.code === "SFTP_PATH_REFUSED";

for (const [kind, name, directory] of [
  ["a file", "notes.txt", false],
  ["an empty folder", "empty", true],
]) {
  test(`an SFTP delete of ${kind} never removes outside through a swapped parent`, async (t) => {
    const f = fixture(t);
    const target = localRoot({ root: f.root, raw: "", write: true });
    const restore = swapOn(t, f, "lstat", { match: (file) => file.endsWith(`/${name}`) });
    const outcome = await settle(removeLocal(target, `sub/${name}`, { directory }));
    assert.equal(restore(), true);
    assert.ok(fs.existsSync(path.join(f.outside, name)), "the outside entry survives");
    if (linux) {
      assert.equal(outcome.error, undefined);
      assert.equal(fs.existsSync(path.join(f.sub, name)), false);
    } else {
      assert.ok(refused(outcome.error), String(outcome.error));
      assert.ok(fs.existsSync(path.join(f.sub, name)));
    }
  });
}

test("a folder listing never shows names from a folder swapped in after the check", async (t) => {
  const f = fixture(t);
  const restore = swapOn(t, f, "readdir");
  const outcome = await settle(listFolder(f.root, "sub"));
  assert.equal(restore(), true);
  if (linux) {
    const names = outcome.value.entries.map((entry) => entry.name);
    assert.deepEqual(names, ["empty", "notes.txt"]);
    assert.equal(outcome.value.entries[1].size, "inside\n".length);
  } else assert.equal(outcome.error?.key, "projectFileUnsuitable");
});

test("an SFTP walk never lists a folder swapped for a link during the walk", async (t) => {
  const f = fixture(t);
  // No folder to descend into: only the folder checks can refuse, not a later open.
  fs.rmdirSync(path.join(f.outside, "empty"));
  fs.rmdirSync(path.join(f.sub, "empty"));
  const target = localRoot({ root: f.root, raw: "" });
  // The first read lists the root, the second the folder `sub`.
  const restore = swapOn(t, f, "readdir", { nth: 2 });
  const outcome = await settle(walkLocal(target));
  assert.equal(restore(), true);
  if (linux)
    assert.deepEqual(
      outcome.value.entries.map((entry) => entry.path),
      ["sub/notes.txt"],
    );
  else assert.ok(refused(outcome.error), String(outcome.error));
});

test("listing and deleting without a swap still work", async (t) => {
  const f = fixture(t);
  const listed = await listFolder(f.root, "sub");
  assert.deepEqual(
    listed.entries.map((entry) => [entry.name, entry.kind]),
    [
      ["empty", "directory"],
      ["notes.txt", "file"],
    ],
  );
  const target = localRoot({ root: f.root, raw: "", write: true });
  await removeLocal(target, "sub/notes.txt");
  await removeLocal(target, "sub/empty", { directory: true });
  assert.deepEqual(fs.readdirSync(f.sub), []);
});

test("inFolder refuses a folder that already is a link and a name with a slash", async (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.outside, path.join(f.root, "link"));
  let acted = false;
  await assert.rejects(
    inFolder(path.join(f.root, "link"), async () => (acted = true)),
    { code: "ELOOP" },
  );
  assert.equal(acted, false);
  await assert.rejects(
    inFolder(f.sub, async (at) => at("../notes.txt")),
    { code: "ELOOP" },
  );
});

// The swap lands between the checks and the open of the folder itself: macOS refuses
// the link in the open (ELOOP), Linux reports ENOTDIR for O_DIRECTORY|O_NOFOLLOW,
// which inFolder names a link as well. Both end in SFTP_PATH_REFUSED.
test("an SFTP delete refuses a parent swapped for a link right before its open", async (t) => {
  const f = fixture(t);
  const target = localRoot({ root: f.root, raw: "", write: true });
  const restore = swapOn(t, f, "open", { match: (file) => file === f.sub });
  const outcome = await settle(removeLocal(target, "sub/notes.txt"));
  assert.equal(restore(), true);
  assert.ok(refused(outcome.error), String(outcome.error));
  assert.ok(fs.existsSync(path.join(f.outside, "notes.txt")));
  assert.ok(fs.existsSync(path.join(f.sub, "notes.txt")));
});

test("an SFTP walk refuses a subfolder swapped for a link right before its open", async (t) => {
  const f = fixture(t);
  const target = localRoot({ root: f.root, raw: "" });
  const restore = swapOn(t, f, "open", { match: (file) => file === f.sub });
  const outcome = await settle(walkLocal(target));
  assert.equal(restore(), true);
  assert.ok(refused(outcome.error), String(outcome.error));
});

test("search never reads a folder swapped for a link after it was queued", async (t) => {
  const f = fixture(t);
  const listed = [];
  const restore = swapOn(t, f, "readdir", {
    match: (folder) => listed.push(folder) === 2,
  });
  const { matches } = await searchFolder(f.root, "", "secret");
  assert.equal(restore(), true);
  assert.deepEqual(matches, []);
  // Linux reads the folder through its descriptor, never by the swapped path.
  if (linux) assert.ok(listed[1].startsWith("/proc/self/fd/"), listed[1]);
});

test(
  "without /proc a Linux listing and SFTP walk are refused rather than unchecked",
  { skip: !linux && "macOS checks in the open itself" },
  async (t) => {
    const f = fixture(t);
    t.mock.method(fs, "readlinkSync", () => {
      throw Object.assign(new Error("no proc"), { code: "ENOENT" });
    });
    await assert.rejects(listFolder(f.root, "sub"), { key: "projectFileUnsuitable" });
    await assert.rejects(walkLocal(localRoot({ root: f.root, raw: "" })), refused);
    assert.deepEqual((await searchFolder(f.root, "", "inside")).matches, []);
  },
);
