import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";

test("directory creation validates a single child, preserves existing contents and requires owner origin", async (t) => {
  const f = await applicationFixture(t);
  const create = (name, options = {}) =>
    f.request("/api/directories", {
      method: "POST",
      body: { path: f.home, name },
      ...options,
    });
  assert.equal((await create("Projects", { origin: null })).status, 403);
  const response = await create("Projects");
  assert.equal(response.status, 201);
  assert.equal((await response.json()).path, path.join(f.home, "Projects"));
  await fs.writeFile(path.join(f.home, "Projects", "keep.txt"), "keep");
  assert.equal((await create("Projects")).status, 409);
  for (const name of [
    "../escape",
    "a/b",
    "a\\b",
    ".",
    "..",
    "",
    "bad\0name",
    "bad\nname",
    " ",
    "x".repeat(256),
    null,
  ])
    assert.equal((await create(name)).status, 400);
  assert.equal(
    await fs.readFile(path.join(f.home, "Projects", "keep.txt"), "utf8"),
    "keep",
  );
});

test("session file explorer bounds listings, previews and writes to its project, rejecting traversal and escaping links", async (t) => {
  const f = await applicationFixture(t);
  const project = path.join(f.home, "project");
  await fs.mkdir(project);
  f.application.sessions.get = async () => ({ id: "fixture", cwd: project });
  await fs.mkdir(path.join(project, "src"));
  await fs.writeFile(
    path.join(project, "src", "hello.txt"),
    "Hello <script>world</script>",
  );
  await fs.writeFile(path.join(f.home, "outside.txt"), "private");
  await fs.symlink(f.home, path.join(project, "escape"));
  await fs.writeFile(path.join(project, "binary.bin"), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(project, "large.txt"), "x".repeat(300000));
  const url = "/api/sessions/fixture/files";
  const get = (suffix) => f.request(url + suffix);
  assert.equal((await get("")).status, 200);
  const listing = await (await get("?path=src")).json();
  assert.equal(listing.path, "src");
  assert.equal(listing.entries[0].name, "hello.txt");
  const text = await (await get("/content?path=src%2Fhello.txt")).json();
  assert.equal(text.text, "Hello <script>world</script>");
  for (const p of ["../outside.txt", "escape/outside.txt", "/etc/passwd"])
    assert.equal((await get(`/content?path=${encodeURIComponent(p)}`)).status, 403);
  assert.equal((await get("?path=escape")).status, 403);
  assert.equal((await get("/content?path=binary.bin")).status, 415);
  assert.equal((await get("/content?path=large.txt")).status, 413);
  assert.equal(
    (await f.request(url, { method: "POST", body: { path: "src", name: "new" } })).status,
    201,
  );
  assert.equal(
    (await f.request(url, { method: "POST", body: { path: "escape", name: "no" } }))
      .status,
    403,
  );
  for (const name of Array.from({ length: 110 }, (_, i) => `file-${i}.txt`))
    await fs.writeFile(path.join(project, name), "test");
  const first = await (await get("")).json();
  const second = await (await get("?page=2")).json();
  assert.equal(first.entries.length, 100);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.equal(
    new Set([...first.entries, ...second.entries].map((entry) => entry.name)).size,
    first.total,
  );
});

test("file preview detects image bytes and never treats SVG or HTML as active markup", async (t) => {
  const f = await applicationFixture(t);
  f.application.sessions.get = async () => ({ cwd: f.home });
  await fs.writeFile(
    path.join(f.home, "image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await fs.writeFile(path.join(f.home, "unsafe.svg"), '<svg onload="alert(1)"></svg>');
  const image = await (
    await f.request("/api/sessions/fixture/files/content?path=image.png")
  ).json();
  assert.equal(image.type, "image");
  assert.ok(image.source.startsWith("data:image/png;base64,"));
  const svg = await (
    await f.request("/api/sessions/fixture/files/content?path=unsafe.svg")
  ).json();
  assert.equal(svg.type, "text");
});
