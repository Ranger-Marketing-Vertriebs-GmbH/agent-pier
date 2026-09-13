import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileFixture } from "../helpers/file-explorer.js";
import { fileProblem } from "../../server/features/files/file-errors.js";
import { preview } from "../../server/features/files/file-reading.js";

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
  const probe = await fs.open(file, constants.O_RDONLY);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  prototype.read = function (buffer, offset, length, position) {
    return originalRead.call(this, buffer, offset, Math.min(length, 2), position);
  };
  t.after(() => {
    prototype.read = originalRead;
  });

  assert.equal((await preview(f.projectScope, "short-reads.png")).type, "image");
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
  const probe = await fs.open(file, constants.O_RDONLY);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  let grew = false;
  prototype.read = async function (...args) {
    const result = await originalRead.apply(this, args);
    if (!grew) {
      grew = true;
      await fs.appendFile(file, "e");
    }
    return result;
  };
  t.after(() => {
    prototype.read = originalRead;
  });

  await assert.rejects(
    preview(f.projectScope, "growing.txt", { limits: { textBytes: 4 } }),
    { code: "FILE_LIMIT_EXCEEDED", status: 413, args: { limit: 4 } },
  );
  assert.equal(await fs.readFile(file, "utf8"), "abcde");
});

test("preview opens with no-follow and preserves an injected open failure", async (t) => {
  const f = await fileFixture(t);
  await fs.writeFile(path.join(f.project, "short.txt"), "short");
  const originalOpen = fs.open;
  const sentinel = fileProblem("FILE_OPEN_SENTINEL", 599);
  let observedFlags = null;
  fs.open = async (_path, flags) => {
    observedFlags = flags;
    throw sentinel;
  };
  t.after(() => {
    fs.open = originalOpen;
  });

  await assert.rejects(preview(f.projectScope, "short.txt"), sentinel);
  assert.ok(observedFlags & constants.O_NOFOLLOW);
});

test("preview closes its descriptor and preserves an injected read failure", async (t) => {
  const f = await fileFixture(t);
  const file = path.join(f.project, "bad.txt");
  await fs.writeFile(file, "content");
  const originalOpen = fs.open;
  const sentinel = fileProblem("FILE_READ_SENTINEL", 598);
  let closes = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const originalClose = handle.close;
    handle.read = async () => {
      throw sentinel;
    };
    handle.close = async (...closeArgs) => {
      closes += 1;
      return originalClose.apply(handle, closeArgs);
    };
    return handle;
  };
  t.after(() => {
    fs.open = originalOpen;
  });
  await assert.rejects(preview(f.projectScope, "bad.txt"), sentinel);
  assert.equal(closes, 1);
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
