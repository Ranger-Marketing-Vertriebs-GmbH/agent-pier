import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileFixture } from "../helpers/file-explorer.js";
import { fileProblem } from "../../server/features/files/file-errors.js";
import { FileNative } from "../../server/features/files/file-native.js";
import { preview } from "../../server/features/files/file-reading.js";
import { previewProjectFile } from "../../server/features/files/project-files.js";

async function swapAncestorWhenPreviewOpens(t, f, directoryName) {
  const selectedDirectory = path.join(f.project, directoryName);
  const outsideDirectory = path.join(f.home, `${directoryName}-outside`);
  await fs.mkdir(selectedDirectory);
  await fs.mkdir(outsideDirectory);
  await fs.writeFile(path.join(selectedDirectory, "sample.txt"), "inside");
  await fs.writeFile(
    path.join(outsideDirectory, "sample.txt"),
    "SYNTHETIC_OUTSIDE_SCOPE",
  );
  const originalRun = FileNative.prototype.run;
  let reads = 0;
  FileNative.prototype.run = async function (operation, args) {
    if (operation === "openFile") {
      await fs.rename(selectedDirectory, `${selectedDirectory}-selected`);
      await fs.symlink(outsideDirectory, selectedDirectory);
    }
    if (operation === "read") reads += 1;
    return originalRun.call(this, operation, args);
  };
  t.after(() => {
    FileNative.prototype.run = originalRun;
  });
  return () => reads;
}

test("text preview decodes UTF-8 and leaves SVG and HTML inert", async (t) => {
  const f = await fileFixture(t);
  for (const [name, text] of [
    ["hello.txt", "Grüße"],
    ["unsafe.svg", '<svg onload="alert(1)"></svg>'],
    ["unsafe.html", '<script>alert("x")</script>'],
  ]) {
    await fs.writeFile(path.join(f.project, name), text);
    assert.deepEqual(await preview(f.projectScope, name), {
      path: name,
      type: "text",
      text,
    });
  }
});

test("project preview rejects an ancestor replaced with an outside link before open", async (t) => {
  const f = await fileFixture(t);
  const readCount = await swapAncestorWhenPreviewOpens(t, f, "new-preview");
  await assert.rejects(preview(f.projectScope, "new-preview/sample.txt"), {
    code: "FILE_PATH_CHANGED",
    status: 409,
  });
  assert.equal(readCount(), 0);
});

test("legacy project preview rejects an ancestor replaced with an outside link before open", async (t) => {
  const f = await fileFixture(t);
  const readCount = await swapAncestorWhenPreviewOpens(t, f, "legacy-preview");
  await assert.rejects(previewProjectFile(f.project, "legacy-preview/sample.txt"), {
    status: 404,
  });
  assert.equal(readCount(), 0);
});

test("image preview recognizes only PNG, JPEG, GIF and WebP magic", async (t) => {
  const f = await fileFixture(t);
  const images = [
    ["png", "image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ["jpg", "image/jpeg", Buffer.from([255, 216, 255, 1])],
    ["gif", "image/gif", Buffer.from("GIF89a")],
    ["webp", "image/webp", Buffer.from("RIFF0000WEBP")],
  ];
  for (const [extension, mime, bytes] of images) {
    const name = `image.${extension}`;
    await fs.writeFile(path.join(f.project, name), bytes);
    const result = await preview(f.projectScope, name);
    assert.deepEqual(result, {
      path: name,
      type: "image",
      source: `data:${mime};base64,${bytes.toString("base64")}`,
    });
  }
  await fs.writeFile(path.join(f.project, "unknown.bin"), Buffer.from([0, 1, 2]));
  await assert.rejects(preview(f.projectScope, "unknown.bin"), {
    code: "FILE_UNSUPPORTED_TYPE",
    status: 415,
  });
  await fs.writeFile(path.join(f.project, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(preview(f.projectScope, "invalid.txt"), {
    code: "FILE_UNSUPPORTED_TYPE",
    status: 415,
  });
});

test("image magic detection tolerates short descriptor reads", async (t) => {
  const f = await fileFixture(t);
  const file = path.join(f.project, "short-reads.png");
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  await fs.writeFile(file, image);
  const originalRun = FileNative.prototype.run;
  let reads = 0;
  FileNative.prototype.run = function (operation, args) {
    if (operation === "read") {
      reads += 1;
      args = { ...args, length: Math.min(args.length, 2) };
    }
    return originalRun.call(this, operation, args);
  };
  t.after(() => {
    FileNative.prototype.run = originalRun;
  });

  assert.equal((await preview(f.projectScope, "short-reads.png")).type, "image");
  assert.ok(reads > 2);
});

test("new and legacy previews retain their distinct text and image limits", async (t) => {
  const f = await fileFixture(t);
  const textName = "large.txt";
  await fs.writeFile(path.join(f.project, textName), "x".repeat(300_000));
  assert.equal(
    (await preview(f.projectScope, textName, { limits: { textBytes: 400_000 } })).text
      .length,
    300_000,
  );
  await assert.rejects(preview(f.projectScope, textName, { legacy: true }), {
    code: "FILE_LIMIT_EXCEEDED",
    args: { limit: 256 * 1024 },
  });

  const imageName = "large.png";
  const image = Buffer.alloc(6 * 1024 * 1024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  await fs.writeFile(path.join(f.project, imageName), image);
  assert.equal((await preview(f.projectScope, imageName)).type, "image");
  await assert.rejects(preview(f.projectScope, imageName, { legacy: true }), {
    code: "FILE_LIMIT_EXCEEDED",
    args: { limit: 5 * 1024 * 1024 },
  });
});

test("a growing UTF-8 preview stops at the byte limit", async (t) => {
  const f = await fileFixture(t);
  const file = path.join(f.project, "growing.txt");
  await fs.writeFile(file, "abcd");
  const originalRun = FileNative.prototype.run;
  let grew = false;
  FileNative.prototype.run = async function (operation, args) {
    const result = await originalRun.call(this, operation, args);
    if (operation === "read" && !grew) {
      grew = true;
      await fs.appendFile(file, "e");
    }
    return result;
  };
  t.after(() => {
    FileNative.prototype.run = originalRun;
  });

  await assert.rejects(
    preview(f.projectScope, "growing.txt", { limits: { textBytes: 4 } }),
    { code: "FILE_LIMIT_EXCEEDED", status: 413, args: { limit: 4 } },
  );
  assert.equal(await fs.readFile(file, "utf8"), "abcde");
});

test("preview preserves an injected native open failure", async (t) => {
  const f = await fileFixture(t);
  await fs.writeFile(path.join(f.project, "short.txt"), "short");
  const originalRun = FileNative.prototype.run;
  const sentinel = fileProblem("FILE_OPEN_SENTINEL", 599);
  let observedPath = null;
  FileNative.prototype.run = function (operation, args) {
    if (operation === "openFile") {
      observedPath = args.path;
      return Promise.reject(sentinel);
    }
    return originalRun.call(this, operation, args);
  };
  t.after(() => {
    FileNative.prototype.run = originalRun;
  });
  await assert.rejects(preview(f.projectScope, "short.txt"), sentinel);
  assert.equal(observedPath, "short.txt");
});

test("preview closes its native owner and preserves an injected read failure", async (t) => {
  const f = await fileFixture(t);
  await fs.writeFile(path.join(f.project, "bad.txt"), "content");
  const originalRun = FileNative.prototype.run;
  const sentinel = fileProblem("FILE_READ_SENTINEL", 598);
  let owner;
  FileNative.prototype.run = function (operation, args) {
    if (operation === "read") {
      owner = this;
      return Promise.reject(sentinel);
    }
    return originalRun.call(this, operation, args);
  };
  t.after(() => {
    FileNative.prototype.run = originalRun;
  });
  await assert.rejects(preview(f.projectScope, "bad.txt"), sentinel);
  assert.ok(owner);
  await assert.rejects(originalRun.call(owner, "openRoot", { path: f.project }), {
    code: "FILE_IO_ERROR",
  });
});

test("preview rejects directories and special files", async (t) => {
  const f = await fileFixture(t);
  await fs.mkdir(path.join(f.project, "directory"));
  const socketPath = path.join(f.project, "s");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const name of ["directory", "s"])
    await assert.rejects(preview(f.projectScope, name), {
      code: "FILE_UNSUPPORTED_TYPE",
      status: 415,
    });
});

test("resolved project links remain bounded while global links allow outside navigation", async (t) => {
  const f = await fileFixture(t);
  await fs.mkdir(path.join(f.project, "nested"));
  await fs.writeFile(path.join(f.project, "nested/text.txt"), "inside");
  await fs.symlink("nested", path.join(f.project, "dir-link"));
  await fs.symlink("nested/text.txt", path.join(f.project, "file-link"));
  for (const selected of ["dir-link/text.txt", "file-link"]) {
    assert.equal((await preview(f.projectScope, selected)).text, "inside");
    assert.equal((await previewProjectFile(f.project, selected)).text, "inside");
  }
  await fs.writeFile(path.join(f.home, "outside.txt"), "global content");
  await fs.symlink("../outside.txt", path.join(f.project, "outside-link"));
  await assert.rejects(preview(f.projectScope, "outside-link"), {
    code: "FILE_OUTSIDE_SCOPE",
  });
  assert.equal(
    (await preview(f.globalScope, path.join(f.project, "outside-link"))).text,
    "global content",
  );
});
