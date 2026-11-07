import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openShareSource,
  projectShareTarget,
  readShareSource,
} from "../../server/features/assistants/agent-share-source.js";
import {
  PIN_HASH_MAX_BYTES,
  PIN_IMAGE_HEAD_BYTES,
  openPinned,
  pinIdentity,
  pinType,
  sameIdentity,
} from "../../server/features/assistants/agent-pinboard-files.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import { png } from "../helpers/agent-share-fixture.js";
import { jpegOf, webpOf } from "../helpers/image-bytes.js";
import { mp4File } from "../helpers/video-fixtures.js";

const agent = { id: "a1" };
const conversation = { id: "c1", assistantId: "a1" };
const key = (expected) => (error) => error?.key === expected;

// A temp workspace for agent a1, a granted project folder `p1` (standing grant
// only) and the fake `assistants` the pinboard reads through.
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-pinboard-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspaces = path.join(dir, "workspaces");
  const workspace = path.join(workspaces, agent.id);
  fs.mkdirSync(path.join(workspace, "out"), { recursive: true });
  const project = path.join(dir, "project");
  fs.mkdirSync(path.join(project, "docs"), { recursive: true });
  const data = path.join(dir, "data");
  fs.mkdirSync(data);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.md"), "secret");
  const grants = { standing: { p1: true }, revoked: false };
  const assistants = {
    attachments: { config: { workspaces } },
    workflows: {
      // A hook's context grants only its own folders (none here).
      context: () => ({ levels: {} }),
      folders: {
        shareRoot(ctx, projectId, owner) {
          if (
            grants.revoked ||
            (!ctx?.levels?.[projectId] && !(owner && grants.standing[projectId]))
          )
            throw assistantProblem("projectFolderNotGranted", 403);
          return { root: project, protectedRoots: [data] };
        },
      },
    },
  };
  const write = (relative, body) => {
    const file = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  return { dir, workspace, project, outside, assistants, grants, write };
}

async function identityOf(f, at) {
  const opened = await openPinned(f.assistants, agent, at);
  try {
    return await pinIdentity(opened.handle, opened.stat);
  } finally {
    await opened.handle.close();
  }
}

test("readShareSource keeps its behaviour", async (t) => {
  const f = fixture(t);
  f.write("big.bin", Buffer.alloc(32));
  f.write("empty.txt", "");
  f.write("ok.txt", "hello");
  const roots = [f.workspace];
  await assert.rejects(
    readShareSource(roots, "big.bin", { maxBytes: 16 }),
    key("shareTooLarge"),
  );
  await assert.rejects(readShareSource(roots, "empty.txt"), key("shareEmpty"));
  const read = await readShareSource(roots, "ok.txt");
  assert.equal(read.name, "ok.txt");
  assert.equal(read.body.toString(), "hello");
  const opened = await openShareSource(roots, "ok.txt");
  assert.equal(opened.relative, "ok.txt");
  assert.equal(opened.stat.size, 5n);
  await opened.handle.close();
});

test("a pinned workspace file opens and names its relative path", async (t) => {
  const f = fixture(t);
  f.write("out/ep6.md", "# Episode 6\n");
  const opened = await openPinned(f.assistants, agent, {
    root: "workspace",
    path: "out/ep6.md",
  });
  try {
    assert.equal(opened.relative, "out/ep6.md");
    assert.equal(opened.name, "ep6.md");
    assert.equal(opened.size, Buffer.byteLength("# Episode 6\n"));
  } finally {
    await opened.handle.close();
  }
  f.write("out/empty.md", "");
  await assert.rejects(
    openPinned(f.assistants, agent, { root: "workspace", path: "out/empty.md" }),
    key("shareEmpty"),
  );
  await assert.rejects(
    openPinned(f.assistants, agent, { root: "workspace", path: "out/none.md" }),
    key("shareNotFound"),
  );
  await assert.rejects(
    openPinned(f.assistants, agent, { root: "elsewhere", path: "out/ep6.md" }),
    key("invalid"),
  );
});

test("a symbolic link in place of the file or a folder is refused", async (t) => {
  const f = fixture(t);
  const file = f.write("out/ep6.md", "# Episode 6\n");
  const at = { root: "workspace", path: "out/ep6.md" };
  fs.rmSync(file);
  fs.symlinkSync(path.join(f.outside, "secret.md"), file);
  await assert.rejects(openPinned(f.assistants, agent, at), key("shareOutside"));
  fs.rmSync(path.join(f.workspace, "out"), { recursive: true });
  fs.writeFileSync(path.join(f.outside, "ep6.md"), "outside");
  fs.symlinkSync(f.outside, path.join(f.workspace, "out"));
  await assert.rejects(openPinned(f.assistants, agent, at), key("shareOutside"));
});

test("a hard-linked file is refused", async (t) => {
  const f = fixture(t);
  fs.linkSync(path.join(f.outside, "secret.md"), path.join(f.workspace, "out", "ep6.md"));
  await assert.rejects(
    openPinned(f.assistants, agent, { root: "workspace", path: "out/ep6.md" }),
    key("shareOutside"),
  );
});

test("a file renamed over the pinned one opens with a new identity", async (t) => {
  const f = fixture(t);
  f.write("out/ep6.md", "draft one\n");
  const at = { root: "workspace", path: "out/ep6.md" };
  const before = await identityOf(f, at);
  assert.ok(before.hash);
  f.write("out/.ep6.tmp", "draft two, longer\n");
  fs.renameSync(path.join(f.workspace, "out/.ep6.tmp"), path.join(f.workspace, at.path));
  const after = await identityOf(f, at);
  assert.equal(sameIdentity(before, after), false);
  assert.notEqual(after.ino, before.ino);
});

test("a file renamed over the pinned one with the same content keeps its identity", async (t) => {
  const f = fixture(t);
  f.write("out/ep6.md", "same text\n");
  const at = { root: "workspace", path: "out/ep6.md" };
  const before = await identityOf(f, at);
  f.write("out/.ep6.tmp", "same text\n");
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(f.workspace, "out/.ep6.tmp"), later, later);
  fs.renameSync(path.join(f.workspace, "out/.ep6.tmp"), path.join(f.workspace, at.path));
  const after = await identityOf(f, at);
  assert.notEqual(after.ino, before.ino);
  assert.notEqual(after.mtimeNs, before.mtimeNs);
  assert.equal(sameIdentity(before, after), true);
});

test("a same-size rewrite of a large file within one millisecond is a new identity", async (t) => {
  const f = fixture(t);
  const big = f.write("out/big.bin", Buffer.alloc(PIN_HASH_MAX_BYTES + 1, 7));
  const at = { root: "workspace", path: "out/big.bin" };
  const seconds = Math.floor(Date.now() / 1000) - 60;
  fs.utimesSync(big, seconds + 0.0001, seconds + 0.0001);
  const before = await identityOf(f, at);
  fs.writeFileSync(big, Buffer.alloc(PIN_HASH_MAX_BYTES + 1, 8));
  fs.utimesSync(big, seconds + 0.0004, seconds + 0.0004);
  const after = await identityOf(f, at);
  assert.equal(
    Math.floor(Number(after.mtimeNs) / 1e6),
    Math.floor(Number(before.mtimeNs) / 1e6),
  );
  assert.equal(sameIdentity(before, after), false);
});

test("a file that shrinks while it is hashed is a conflict", async (t) => {
  const f = fixture(t);
  const file = f.write("out/ep6.md", "x".repeat(200_000));
  const opened = await openPinned(f.assistants, agent, {
    root: "workspace",
    path: "out/ep6.md",
  });
  try {
    fs.truncateSync(file, 100_000);
    await assert.rejects(pinIdentity(opened.handle, opened.stat), (error) => {
      return error.key === "conflict" && error.status === 409;
    });
  } finally {
    await opened.handle.close();
  }
});

test("touching a small file keeps its identity", async (t) => {
  const f = fixture(t);
  const small = f.write("out/small.md", "small\n");
  const big = f.write("out/big.bin", Buffer.alloc(PIN_HASH_MAX_BYTES + 1, 7));
  const later = new Date(Date.now() + 60_000);
  for (const [file, same] of [
    [small, true],
    [big, false],
  ]) {
    const at = { root: "workspace", path: path.relative(f.workspace, file) };
    const before = await identityOf(f, at);
    assert.equal("hash" in before, same);
    fs.utimesSync(file, later, later);
    const after = await identityOf(f, at);
    assert.equal(sameIdentity(before, after), same);
  }
  // Stored extras are ignored; null never matches.
  const stored = { size: 1, mtimeNs: "2", ino: 3, type: "text/markdown", kind: "text" };
  assert.equal(sameIdentity(stored, { size: 1, mtimeNs: "2", ino: 3 }), true);
  assert.equal(sameIdentity(stored, null), false);
  assert.equal(sameIdentity(null, null), false);
});

test("a project pin opens only while the folder is granted", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, "docs", "plan.md"), "# Plan\n");
  const at = { root: "project:p1", path: "docs/plan.md" };
  const opened = await openPinned(f.assistants, agent, at);
  assert.equal(opened.relative, "docs/plan.md");
  await opened.handle.close();
  f.grants.revoked = true;
  await assert.rejects(
    openPinned(f.assistants, agent, at),
    key("projectFolderNotGranted"),
  );
  f.grants.revoked = false;
  const again = await openPinned(f.assistants, agent, at);
  await again.handle.close();
  // A stored path whose folder became a link (even one inside the project) is
  // refused; a link out of the project is refused by the share rules.
  fs.renameSync(path.join(f.project, "docs"), path.join(f.project, "real"));
  fs.symlinkSync(path.join(f.project, "real"), path.join(f.project, "docs"));
  await assert.rejects(openPinned(f.assistants, agent, at), key("shareOutside"));
  fs.rmSync(path.join(f.project, "docs"));
  fs.symlinkSync(f.outside, path.join(f.project, "docs"));
  await assert.rejects(openPinned(f.assistants, agent, at), key("projectPathRefused"));
});

test("projectShareTarget resolves a hook's folders at pin time", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, "docs", "plan.md"), "# Plan\n");
  const hook = { invocation: { hook: { id: "h1" }, assertCurrent() {} }, conversation };
  const request = { projectId: "p1", path: "docs/plan.md" };
  assert.throws(
    () => projectShareTarget(f.assistants, agent, request, hook),
    key("projectFolderNotGranted"),
  );
  await assert.rejects(
    openPinned(
      f.assistants,
      agent,
      { root: "project:p1", path: request.path },
      {
        scope: hook,
      },
    ),
    key("projectFolderNotGranted"),
  );
  const target = projectShareTarget(f.assistants, agent, request, null);
  assert.equal(target.relative, "docs/plan.md");
  assert.deepEqual(target.roots, [f.project]);
  assert.equal(target.refuseDirs.length, 1);
  // The owner's own chat uses the agent's standing grants.
  const owner = { invocation: { attemptId: null }, conversation };
  assert.equal(
    projectShareTarget(f.assistants, agent, request, owner).relative,
    "docs/plan.md",
  );
  assert.throws(
    () =>
      projectShareTarget(
        f.assistants,
        agent,
        { projectId: "p1", path: "../outside" },
        null,
      ),
    key("projectPathRefused"),
  );
  assert.throws(
    () =>
      projectShareTarget(f.assistants, agent, { projectId: "p1", path: "none.md" }, null),
    key("shareNotFound"),
  );
});

test("pinType names video, audio, image, markdown and other files", async (t) => {
  const f = fixture(t);
  const ftyp = (brands) => {
    const box = Buffer.alloc(8 + brands.length * 4);
    box.writeUInt32BE(box.length, 0);
    box.write("ftyp", 4, "ascii");
    brands.forEach((brand, i) => box.write(brand, 8 + i * 4, "ascii"));
    return box;
  };
  const mp4 = Buffer.concat([
    ftyp(["isom", "\0\0\u0002\0", "isom", "mp42"]),
    Buffer.alloc(64),
  ]);
  const heic = Buffer.concat([
    ftyp(["heic", "\0\0\0\0", "mif1", "heic"]),
    Buffer.alloc(64),
  ]);
  const id3 = Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]),
    Buffer.alloc(64),
  ]);
  const cases = [
    ["clip.mp4", mp4, { type: "video/mp4", kind: "video" }],
    ["song.mp3", id3, { type: "audio/mpeg", kind: "audio" }],
    ["chart.png", png, { type: "image/png", kind: "image" }],
    ["photo.jpg", jpegOf(), { type: "image/jpeg", kind: "image" }],
    ["photo.webp", webpOf(), { type: "image/webp", kind: "image" }],
    [
      "anim.gif",
      Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"),
      { type: "image/gif", kind: "image" },
    ],
    ["photo.heic", heic, { type: "application/octet-stream", kind: "file" }],
    ["ep.md", "# Episode\n", { type: "text/markdown", kind: "text" }],
    ["x.bin", Buffer.from([1, 2, 3]), { type: "application/octet-stream", kind: "file" }],
  ];
  for (const [name, body, expected] of cases) {
    f.write(name, body);
    const opened = await openPinned(f.assistants, agent, {
      root: "workspace",
      path: name,
    });
    try {
      const type = await pinType(opened.handle, opened.size, opened.name);
      assert.deepEqual({ type: type.type, kind: type.kind }, expected, name);
      assert.equal("duration" in type, false, name);
    } finally {
      await opened.handle.close();
    }
  }
  // A movie box names the duration, read through the descriptor at its end.
  f.write("ep.mp4", mp4File({ payload: 9000 }));
  const opened = await openPinned(f.assistants, agent, {
    root: "workspace",
    path: "ep.mp4",
  });
  try {
    assert.deepEqual(await pinType(opened.handle, opened.size, opened.name), {
      type: "video/mp4",
      kind: "video",
      duration: 42,
    });
  } finally {
    await opened.handle.close();
  }
});

test("pinType sniffs a large image from its header only", async (t) => {
  const f = fixture(t);
  const body = Buffer.alloc(10 * 1024 * 1024);
  png.copy(body);
  f.write("big.png", body);
  const opened = await openPinned(f.assistants, agent, {
    root: "workspace",
    path: "big.png",
  });
  let read = 0;
  const counting = {
    async read(buffer, offset, length, position) {
      const result = await opened.handle.read(buffer, offset, length, position);
      read += result.bytesRead;
      return result;
    },
  };
  try {
    const type = await pinType(counting, opened.size, opened.name);
    assert.deepEqual(type, { type: "image/png", kind: "image" });
    assert.ok(read <= PIN_IMAGE_HEAD_BYTES + 4096, `read ${read} bytes`);
  } finally {
    await opened.handle.close();
  }
});
