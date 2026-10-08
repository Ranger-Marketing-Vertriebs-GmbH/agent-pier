import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatImages } from "../../server/features/chat/chat-images.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-image-existence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project"),
    home = path.join(root, "home");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  const images = new ChatImages({ home, ...options });
  const session = { id: "fixture", cwd };
  const scan = async (...texts) =>
    (
      await images.descriptors(session, {
        providerSessionId: "native",
        messages: texts.map((text, index) => ({
          id: `m${index}`,
          role: "assistant",
          text,
        })),
      })
    ).map((message) => message.images);
  return { root, cwd, home, images, scan };
}

test("mentioned image names without a file on disk never become image cards", async (t) => {
  const f = fixture(t);
  const [images] = await f.scan(
    "Schreibe nach `datei.png`, dann /tmp/lab-preview-<type>.png und " +
      "GET /api/cli/parts/<type>/preview.png. Auch GET /api/cli/preview.png zählt nicht.",
  );
  assert.deepEqual(images, []);
});

test("templated, globbed and request-line values are rejected before touching the disk", async (t) => {
  const f = fixture(t);
  for (const name of ["{name}.png", "*.png", "$out.png", "a,b.png", "a|b.png"])
    fs.writeFileSync(path.join(f.cwd, name), png);
  fs.mkdirSync(path.join(f.cwd, "api"));
  fs.writeFileSync(path.join(f.cwd, "api", "preview.png"), png);
  const lstat = mock.method(fsPromises, "lstat");
  t.after(() => lstat.mock.restore());
  const [images] = await f.scan(
    "`{name}.png` `*.png` `$out.png` `a,b.png` `a|b.png` " +
      "POST ./api/preview.png <x.png>",
  );
  assert.deepEqual(images, []);
  assert.equal(lstat.mock.callCount(), 0);
  fs.writeFileSync(path.join(f.cwd, "my file.png"), png);
  assert.deepEqual(await f.scan("Look at my file.png", "`GET my file.png`"), [[], []]);
});

test("a quoted or whole-line path with spaces gets a card only while the file exists", async (t) => {
  let now = 0;
  const f = fixture(t, { now: () => now });
  const desktop = path.join(f.root, "Desktop");
  fs.mkdirSync(desktop);
  const quoted = path.join(desktop, "Bildschirmfoto 2026-10-08 um 11.45.00.png"),
    line = path.join(desktop, "Bildschirmfoto 2026-10-08 um 11.46.00.png"),
    relative = "./my file.png";
  const texts = [`Siehe "${quoted}"`, `Hier:\n${line}\n`, `\`${relative}\``];
  assert.deepEqual(await f.scan(...texts), [[], [], []]);
  for (const file of [quoted, line, path.join(f.cwd, "my file.png")])
    fs.writeFileSync(file, png);
  now += 10_001;
  const result = await f.scan(...texts);
  assert.deepEqual(
    result.map((found) => found.map((image) => image.fullPath)),
    [[quoted], [line], [path.join(f.cwd, "my file.png")]],
  );
});

test("existing references still produce cards in every supported notation", async (t) => {
  const f = fixture(t);
  const absolute = path.join(f.root, "pasted.png");
  for (const file of [absolute, path.join(f.cwd, "image space.png")])
    fs.writeFileSync(file, png);
  for (const name of ["relative.png", "bare.png", "markdown.png", "uri.png"])
    fs.writeFileSync(path.join(f.cwd, name), png);
  fs.writeFileSync(path.join(f.home, "x.png"), png);
  const [images] = await f.scan(
    [
      "`relative.png` bare.png",
      "![b](<./image space.png>) ![m](./markdown.png)",
      "~/x.png",
      `file://${encodeURI(path.join(f.cwd, "uri.png"))}`,
      absolute,
    ].join("\n"),
  );
  assert.deepEqual(images.map((image) => path.basename(image.fullPath)).sort(), [
    "bare.png",
    "image space.png",
    "markdown.png",
    "pasted.png",
    "relative.png",
    "uri.png",
    "x.png",
  ]);
  const [user] = await f.scan(absolute);
  assert.deepEqual(
    user.map((image) => image.fullPath),
    [absolute],
  );
});

test("files that are not raster images, symlinks, directories and oversized files are dropped", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, "text.png"), "private-token-value");
  fs.writeFileSync(path.join(f.cwd, "okay.png"), png);
  fs.symlinkSync(path.join(f.cwd, "okay.png"), path.join(f.cwd, "link.png"));
  fs.mkdirSync(path.join(f.cwd, "folder.png"));
  const handle = fs.openSync(path.join(f.cwd, "large.png"), "w");
  fs.writeSync(handle, png);
  fs.ftruncateSync(handle, 20 * 1024 * 1024 + 1);
  fs.closeSync(handle);
  const [images] = await f.scan("text.png link.png folder.png large.png okay.png");
  assert.deepEqual(
    images.map((image) => image.path),
    ["okay.png"],
  );
});

test("a file written after a scan appears once the negative cache expires", async (t) => {
  let now = 1_000_000;
  const f = fixture(t, { now: () => now });
  assert.deepEqual(await f.scan("later.png"), [[]]);
  fs.writeFileSync(path.join(f.cwd, "later.png"), png);
  now += 5_000;
  assert.deepEqual(await f.scan("later.png"), [[]]);
  now += 5_001;
  const [images] = await f.scan("later.png");
  assert.deepEqual(
    images.map((image) => image.path),
    ["later.png"],
  );
});

test("a changed file is probed again while unchanged files reuse the cached result", async (t) => {
  const f = fixture(t);
  const file = path.join(f.cwd, "changing.png");
  fs.writeFileSync(file, png);
  const open = mock.method(fsPromises, "open");
  t.after(() => open.mock.restore());
  assert.equal((await f.scan("changing.png"))[0].length, 1);
  assert.equal((await f.scan("changing.png"))[0].length, 1);
  assert.equal(open.mock.callCount(), 1);
  fs.writeFileSync(file, "no longer an image");
  assert.deepEqual(await f.scan("changing.png"), [[]]);
});

test("many mentioned names probe the disk a bounded number of times per scan", async (t) => {
  const f = fixture(t);
  const texts = Array.from({ length: 400 }, (_, message) =>
    Array.from({ length: 8 }, (_, index) => `missing-${message}-${index}.png`).join(" "),
  );
  const lstat = mock.method(fsPromises, "lstat");
  t.after(() => lstat.mock.restore());
  const result = await f.scan(...texts);
  assert.ok(result.every((images) => images.length === 0));
  const first = lstat.mock.callCount();
  assert.ok(first > 0 && first <= 256, `first scan probed ${first} paths`);
  lstat.mock.resetCalls();
  await f.scan(...texts.slice(-10));
  assert.equal(lstat.mock.callCount(), 0, "recent misses are cached");
});

test("existing images stay within the conversation image budget", async (t) => {
  const f = fixture(t);
  const names = Array.from({ length: 80 }, (_, index) => `budget-${index}.png`);
  for (const name of names) fs.writeFileSync(path.join(f.cwd, name), png);
  const result = await f.scan(...names);
  assert.equal(result.flat().length, 64);
  assert.deepEqual(result.at(-1)[0].path, names.at(-1));
});
