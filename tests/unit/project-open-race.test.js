import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  appendFile,
  editFile,
  readFile,
  searchFolder,
  viewImage,
  writeFile,
} from "../../server/features/assistants/project-files.js";
import {
  localRoot,
  openLocalSource,
  writeLocal,
} from "../../server/features/sftp/sftp-local.js";
import {
  openInside,
  openInsideSync,
} from "../../server/features/assistants/project-open.js";

// A process that can change the project folder swaps a parent folder for a link to
// an outside folder after the path was checked and before it is opened, and swaps
// it back right after the open, so a check after the open sees the folder as before.
const png = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-race-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.mkdirSync(outside);
  for (const [dir, text] of [
    [path.join(root, "sub"), "inside\n"],
    [outside, "secret\n"],
  ]) {
    fs.writeFileSync(path.join(dir, "notes.txt"), text);
    fs.writeFileSync(path.join(dir, "pic.png"), png);
  }
  return { root, outside, sub: path.join(root, "sub") };
}

// Swaps `folder` for a link to `outside` on the first open below it, opens, and
// swaps back, for the asynchronous and the synchronous open.
function swapOnOpen(t, folder, outside) {
  const moved = `${folder}.moved`;
  let swapped = 0;
  const below = (file) => typeof file === "string" && file.startsWith(folder + path.sep);
  const swap = () => {
    fs.renameSync(folder, moved);
    fs.symlinkSync(outside, folder);
  };
  const restore = () => {
    fs.unlinkSync(folder);
    fs.renameSync(moved, folder);
  };
  const promisesOpen = fs.promises.open;
  const openSync = fs.openSync;
  t.mock.method(fs.promises, "open", async (file, ...rest) => {
    if (!below(file) || swapped++) return promisesOpen(file, ...rest);
    swap();
    try {
      return await promisesOpen(file, ...rest);
    } finally {
      restore();
    }
  });
  t.mock.method(fs, "openSync", (file, ...rest) => {
    if (!below(file) || swapped++) return openSync(file, ...rest);
    swap();
    try {
      return openSync(file, ...rest);
    } finally {
      restore();
    }
  });
  return () => swapped;
}

const unsuitable = (error) => error.key === "projectFileUnsuitable";

test("a text read refuses a parent folder swapped for a link before the open", async (t) => {
  const { root, outside, sub } = fixture(t);
  const opens = swapOnOpen(t, sub, outside);
  await assert.rejects(readFile(root, "sub/notes.txt"), unsuitable);
  assert.equal(opens(), 1);
});

test("an image read refuses a parent folder swapped for a link before the open", async (t) => {
  const { root, outside, sub } = fixture(t);
  const opens = swapOnOpen(t, sub, outside);
  await assert.rejects(viewImage(root, "sub/pic.png"), unsuitable);
  assert.equal(opens(), 1);
});

test("an edit and an append refuse to read through a swapped parent folder", async (t) => {
  const { root, outside, sub } = fixture(t);
  swapOnOpen(t, sub, outside);
  await assert.rejects(
    editFile(root, "sub/notes.txt", { oldText: "secret", newText: "leaked" }),
    unsuitable,
  );
  t.mock.restoreAll();
  swapOnOpen(t, sub, outside);
  await assert.rejects(appendFile(root, "sub/notes.txt", "more\n"), unsuitable);
  assert.equal(fs.readFileSync(path.join(outside, "notes.txt"), "utf8"), "secret\n");
  assert.equal(fs.readFileSync(path.join(sub, "notes.txt"), "utf8"), "inside\n");
});

test("search skips a file whose parent folder is swapped before the open", async (t) => {
  const { root, outside, sub } = fixture(t);
  swapOnOpen(t, sub, outside);
  const { matches } = await searchFolder(root, "", "secret");
  assert.deepEqual(matches, []);
});

test("a write refuses to create its temporary file through a swapped parent", async (t) => {
  const { root, outside, sub } = fixture(t);
  swapOnOpen(t, sub, outside);
  assert.throws(() => writeFile(root, "sub/new.txt", "planted\n"));
  assert.deepEqual(fs.readdirSync(outside).sort(), ["notes.txt", "pic.png"]);
  assert.deepEqual(fs.readdirSync(sub).sort(), ["notes.txt", "pic.png"]);
});

test("an SFTP upload source refuses a parent folder swapped before the open", async (t) => {
  const { root, outside, sub } = fixture(t);
  const target = localRoot({ root, raw: "sub" });
  swapOnOpen(t, sub, outside);
  await assert.rejects(
    openLocalSource(target, "notes.txt"),
    (error) => error.code === "SFTP_PATH_REFUSED",
  );
});

test("an SFTP download refuses to create its part file through a swapped parent", async (t) => {
  const { root, outside, sub } = fixture(t);
  const target = localRoot({ root, raw: "", write: true });
  swapOnOpen(t, sub, outside);
  await assert.rejects(
    writeLocal(target, "sub/new.txt", Readable.from([Buffer.from("planted")])),
    (error) => error.code === "SFTP_PATH_REFUSED",
  );
  assert.deepEqual(fs.readdirSync(outside).sort(), ["notes.txt", "pic.png"]);
});

test("reads and writes without a swap still work", async (t) => {
  const { root } = fixture(t);
  assert.equal((await readFile(root, "sub/notes.txt")).content, "inside\n");
  assert.equal((await viewImage(root, "sub/pic.png")).mimeType, "image/png");
  writeFile(root, "sub/new.txt", "fresh\n");
  assert.equal((await readFile(root, "sub/new.txt")).content, "fresh\n");
  const target = localRoot({ root, raw: "sub", write: true });
  const handle = await openLocalSource(target, "notes.txt");
  await handle.close();
  await writeLocal(target, "copy.txt", Readable.from([Buffer.from("copied")]));
  assert.equal(fs.readFileSync(path.join(root, "sub", "copy.txt"), "utf8"), "copied");
});

test(
  "without /proc a Linux read is refused rather than unchecked",
  { skip: process.platform === "darwin" && "macOS checks in the open itself" },
  async (t) => {
    const { root } = fixture(t);
    t.mock.method(fs, "readlinkSync", () => {
      throw Object.assign(new Error("no proc"), { code: "ENOENT" });
    });
    await assert.rejects(readFile(root, "sub/notes.txt"), unsuitable);
  },
);

const linuxOnly = {
  skip: process.platform === "darwin" && "macOS refuses in the open itself",
};

test(
  "a failed cleanup of an escaped create still closes the descriptor and refuses",
  linuxOnly,
  async (t) => {
    const { outside, sub } = fixture(t);
    swapOnOpen(t, sub, outside);
    const closed = [];
    const closeSync = fs.closeSync;
    t.mock.method(fs, "closeSync", (fd) => {
      closed.push(fd);
      return closeSync(fd);
    });
    t.mock.method(fs, "rmSync", () => {
      throw Object.assign(new Error("is a directory"), { code: "EISDIR" });
    });
    const { O_WRONLY, O_CREAT, O_EXCL } = fs.constants;
    assert.throws(
      () => openInsideSync(path.join(sub, "new.txt"), O_WRONLY | O_CREAT | O_EXCL, 0o600),
      { code: "ELOOP" },
    );
    assert.equal(closed.length, 1);
    t.mock.restoreAll();
    swapOnOpen(t, sub, outside);
    t.mock.method(fs, "rmSync", () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await assert.rejects(
      openInside(path.join(sub, "other.txt"), O_WRONLY | O_CREAT | O_EXCL, 0o600),
      { code: "ELOOP" },
    );
    // The fixture's cleanup needs the real rmSync again.
    t.mock.restoreAll();
  },
);

test(
  "an escaped open without O_EXCL never removes the outside file",
  linuxOnly,
  async (t) => {
    const { outside, sub } = fixture(t);
    swapOnOpen(t, sub, outside);
    const { O_WRONLY, O_CREAT } = fs.constants;
    await assert.rejects(openInside(path.join(sub, "notes.txt"), O_WRONLY | O_CREAT), {
      code: "ELOOP",
    });
    assert.equal(fs.readFileSync(path.join(outside, "notes.txt"), "utf8"), "secret\n");
  },
);
