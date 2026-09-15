import test from "node:test";
import assert from "node:assert/strict";
import { collectUploadSelection } from "../../web/features/files/file-upload-selection.js";

const options = { maxEntries: 50, maxDepth: 8 };
function file(name, relativePath = "", content = "data") {
  const result = new File([content], name);
  Object.defineProperty(result, "webkitRelativePath", { value: relativePath });
  return result;
}
function directory(name, batches) {
  return {
    name,
    isDirectory: true,
    createReader() {
      const pending = [...batches, []];
      return { readEntries: (done) => queueMicrotask(() => done(pending.shift())) };
    },
  };
}
test("relative file selection retains original File identities and distinct folders", async () => {
  const a = file("same.txt", "root/a/same.txt");
  const b = file("same.txt", "root/b/same.txt");
  const selected = await collectUploadSelection([a, b], options);
  assert.equal(selected.files[0].file, a);
  assert.equal(selected.files[1].file, b);
  assert.deepEqual(selected.directories, ["root", "root/a", "root/b"]);
  assert.deepEqual(selected.omissions, ["emptyDirectories"]);
});

test("native file input uses its captured FileList instead of fallible WebKit file entries", async () => {
  const selected = file("native.txt");
  const input = {
    files: [selected],
    webkitdirectory: false,
    webkitEntries: [
      {
        name: "native.txt",
        isFile: true,
        file: (_, reject) =>
          reject(new DOMException("Path does not exist", "NotFoundError")),
      },
    ],
  };
  const result = await collectUploadSelection(input, options);
  assert.equal(result.files[0].file, selected);
});
test("directory readers consume every batch and retain empty directories", async () => {
  const a = file("one.txt");
  const root = directory("root", [
    [{ name: a.name, isFile: true, file: (done) => done(a) }],
    [directory("empty", [])],
  ]);
  const input = { items: [{ kind: "file", webkitGetAsEntry: () => root }] };
  const selected = await collectUploadSelection(input, options);
  assert.deepEqual(selected.directories, ["root", "root/empty"]);
  assert.equal(selected.files[0].relativePath, "root/one.txt");
  assert.deepEqual(selected.omissions, []);
});
test("empty file-only folder selections still disclose omitted empty directories", async () => {
  const selected = await collectUploadSelection(
    { files: [], webkitdirectory: true },
    options,
  );
  assert.deepEqual(selected.omissions, ["emptyDirectories"]);
});
test("malformed paths and colliding declarations fail instead of flattening or replacing", async () => {
  for (const relative of [
    "/a",
    "../a",
    "a/../b",
    "a//b",
    "a/./b",
    "a\\b",
    "a\0b",
    "a/\ud800",
  ]) {
    await assert.rejects(collectUploadSelection([file("x", relative)], options));
  }
  await assert.rejects(collectUploadSelection([file("same"), file("same")], options));
  await assert.rejects(collectUploadSelection([file("a"), file("x", "a/x")], options));
  const literal = file("%2e%2e.txt", "dir/%2e%2e.txt");
  assert.equal(
    (await collectUploadSelection([literal], options)).files[0].relativePath,
    "dir/%2e%2e.txt",
  );
});
test("implicit ancestors count toward entry and depth bounds during collection", async () => {
  await assert.rejects(
    collectUploadSelection([file("x", "a/b/x")], { ...options, maxEntries: 2 }),
  );
  await assert.rejects(
    collectUploadSelection([file("x", "a/b/x")], { ...options, maxDepth: 2 }),
  );
  const failed = directory("broken", []);
  failed.createReader = () => ({
    readEntries: (_, reject) => reject(new Error("unreadable")),
  });
  await assert.rejects(
    collectUploadSelection(
      { items: [{ kind: "file", webkitGetAsEntry: () => failed }] },
      options,
    ),
  );
});
