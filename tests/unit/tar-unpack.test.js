import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { unpackTarGz } from "../../server/features/tools/tar-unpack.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { tar, tarGz } from "../helpers/tar-fixture.js";

const { tools } = serverMessages;

// A fresh temp parent per test: the archive and the destination live side by side, so
// a test can walk the parent and prove nothing landed outside `dest`.
function workspace(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tar-unpack-")));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let count = 0;
  return {
    parent,
    async unpack(bytes, options = {}) {
      count += 1;
      const file = path.join(parent, `archive-${count}.tar.gz`);
      const dest = path.join(parent, `dest-${count}`);
      fs.writeFileSync(file, bytes);
      fs.mkdirSync(dest);
      await unpackTarGz(file, dest, "pkg", options.signal, options.limits);
      return dest;
    },
    rejects(bytes, message, options) {
      return assert.rejects(this.unpack(bytes, options), { message });
    },
  };
}

test("unpacks files, folders, relative links and modes inside the top folder", async (t) => {
  const ws = workspace(t);
  const dest = await ws.unpack(
    tarGz([
      { name: "pkg/", type: "dir" },
      { name: "pkg/bin/", type: "dir" },
      { name: "pkg/bin/tool", content: "#!/bin/sh\n", mode: 0o4755 },
      { name: "pkg/lib/a.txt", content: "alpha", mode: 0o644 },
      { name: "pkg/current", type: "symlink", link: "lib" },
    ]),
  );
  const tool = path.join(dest, "pkg/bin/tool");
  assert.equal(fs.readFileSync(tool, "utf8"), "#!/bin/sh\n");
  assert.equal(fs.statSync(tool).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(path.join(dest, "pkg/lib/a.txt")).mode & 0o7777, 0o644);
  assert.equal(fs.readlinkSync(path.join(dest, "pkg/current")), "lib");
  assert.equal(fs.readFileSync(path.join(dest, "pkg/current/a.txt"), "utf8"), "alpha");
});

test("PAX and GNU long names over 100 bytes unpack under their full name", async (t) => {
  const ws = workspace(t);
  const deep = `pkg/${"d".repeat(70)}/${"e".repeat(70)}`;
  const dest = await ws.unpack(
    tarGz([
      { name: `${deep}/pax-file.txt`, content: "pax", pax: true },
      { name: `${deep}/gnu-file.txt`, content: "gnu", gnuLong: true },
      { name: `${deep}/pax-link`, type: "symlink", link: "pax-file.txt", pax: true },
      {
        name: `${deep}/gnu-link`,
        type: "symlink",
        link: `${"../".repeat(2)}${deep.slice(4)}/gnu-file.txt`,
        gnuLong: true,
      },
    ]),
  );
  assert.equal(fs.readFileSync(path.join(dest, deep, "pax-file.txt"), "utf8"), "pax");
  assert.equal(fs.readFileSync(path.join(dest, deep, "gnu-file.txt"), "utf8"), "gnu");
  assert.equal(fs.readFileSync(path.join(dest, deep, "pax-link"), "utf8"), "pax");
  assert.equal(fs.readFileSync(path.join(dest, deep, "gnu-link"), "utf8"), "gnu");
});

test("a hard link becomes a copy of a file unpacked earlier inside the top folder", async (t) => {
  const ws = workspace(t);
  const dest = await ws.unpack(
    tarGz([
      { name: "pkg/bin/java", content: "binary", mode: 0o755 },
      { name: "pkg/bin/java-copy", type: "hardlink", link: "pkg/bin/java" },
    ]),
  );
  const copy = path.join(dest, "pkg/bin/java-copy");
  assert.equal(fs.readFileSync(copy, "utf8"), "binary");
  assert.equal(fs.lstatSync(copy).isFile(), true);
  assert.equal(fs.statSync(copy).mode & 0o111, 0o111);
});

test("refuses ../, absolute names, names outside the top folder and backslashes", async (t) => {
  const ws = workspace(t);
  for (const name of [
    "pkg/../evil.txt",
    "../evil.txt",
    "/tmp/evil.txt",
    "other/evil.txt",
    "pkg\\evil.txt",
    "pkg/sub\\..\\..\\evil.txt",
    "pkg/./evil.txt",
  ])
    await ws.rejects(tarGz([{ name, content: "x" }]), tools.unsafeArchivePath);
  await ws.rejects(
    tarGz([{ name: `pkg/${"x".repeat(150)}/../../evil.txt`, content: "x", pax: true }]),
    tools.unsafeArchivePath,
  );
});

test("refuses a link that leaves the top folder, directly or through a chain", async (t) => {
  const ws = workspace(t);
  for (const link of ["../outside", "/etc", "..", "sub/../../x", "a\\b"])
    await ws.rejects(
      tarGz([{ name: "pkg/link", type: "symlink", link }]),
      tools.unsafeArchivePath,
    );
  // Each link alone stays inside; together they resolve to dest itself.
  await ws.rejects(
    tarGz([
      { name: "pkg/x/", type: "dir" },
      { name: "pkg/x/up", type: "symlink", link: ".." },
      { name: "pkg/escape", type: "symlink", link: "x/up/.." },
    ]),
    tools.unsafeArchivePath,
  );
  // A later entry never writes through a link unpacked earlier.
  await ws.rejects(
    tarGz([
      { name: "pkg/real/", type: "dir" },
      { name: "pkg/alias", type: "symlink", link: "real" },
      { name: "pkg/alias/file.txt", content: "x" },
    ]),
    tools.unsafeArchivePath,
  );
});

test("refuses a hard link to a path not unpacked before or outside the top folder", async (t) => {
  const ws = workspace(t);
  for (const link of ["pkg/missing", "../etc/passwd", "/etc/passwd", "other/file"])
    await ws.rejects(
      tarGz([
        { name: "pkg/file", content: "x" },
        { name: "pkg/copy", type: "hardlink", link },
      ]),
      tools.unsafeArchivePath,
    );
  // Only regular files: never a link or a folder.
  for (const link of ["pkg/link", "pkg/dir"])
    await ws.rejects(
      tarGz([
        { name: "pkg/dir/", type: "dir" },
        { name: "pkg/link", type: "symlink", link: "dir" },
        { name: "pkg/copy", type: "hardlink", link },
      ]),
      tools.unsafeArchivePath,
    );
  // Before its target: refused, even when the target follows.
  await ws.rejects(
    tarGz([
      { name: "pkg/copy", type: "hardlink", link: "pkg/file" },
      { name: "pkg/file", content: "x" },
    ]),
    tools.unsafeArchivePath,
  );
});

test("refuses device files", async (t) => {
  const ws = workspace(t);
  await ws.rejects(
    tarGz([{ name: "pkg/dev", type: "char" }]),
    tools.specialArchiveFilesForbidden,
  );
});

test("refuses names that differ only in case", async (t) => {
  const ws = workspace(t);
  await ws.rejects(
    tarGz([
      { name: "pkg/Readme.txt", content: "a" },
      { name: "pkg/README.txt", content: "b" },
    ]),
    tools.duplicateArchivePaths,
  );
});

test("stops at the expanded size and file count limits", async (t) => {
  const ws = workspace(t);
  const files = [
    { name: "pkg/a", content: "12345" },
    { name: "pkg/b", content: "12345" },
    { name: "pkg/c", content: "12345" },
  ];
  await ws.rejects(tarGz(files), tools.archiveSizeExceeded, {
    limits: { maxExpanded: 12, maxFiles: 100 },
  });
  await ws.rejects(tarGz(files), tools.archiveSizeExceeded, {
    limits: { maxExpanded: 1000, maxFiles: 2 },
  });
  // A hard link counts with the size of the file it copies.
  await ws.rejects(
    tarGz([
      { name: "pkg/a", content: "1234567" },
      { name: "pkg/b", type: "hardlink", link: "pkg/a" },
    ]),
    tools.archiveSizeExceeded,
    { limits: { maxExpanded: 10, maxFiles: 100 } },
  );
  await ws.unpack(tarGz(files), { limits: { maxExpanded: 15, maxFiles: 3 } });
});

test("a truncated or non-gzip archive fails with archiveInvalid", async (t) => {
  const ws = workspace(t);
  const raw = tar([{ name: "pkg/file", content: "x".repeat(2000) }]);
  await ws.rejects(gzipSync(raw.subarray(0, 1024)), tools.archiveInvalid);
  await ws.rejects(gzipSync(raw.subarray(0, 300)), tools.archiveInvalid);
  const compressed = tarGz([{ name: "pkg/file", content: "x" }]);
  await ws.rejects(compressed.subarray(0, compressed.length - 12), tools.archiveInvalid);
  await ws.rejects(Buffer.from("not a gzip stream"), tools.archiveInvalid);
  await ws.rejects(Buffer.alloc(0), tools.archiveInvalid);
  const corrupt = Buffer.from(raw);
  corrupt[10] ^= 1;
  await ws.rejects(gzipSync(corrupt), tools.archiveInvalid);
});

test("an aborted signal stops unpacking", async (t) => {
  const ws = workspace(t);
  const controller = new AbortController();
  controller.abort();
  await ws.rejects(
    tarGz([{ name: "pkg/file", content: "x" }]),
    tools.installationAbortedOrTimedOut,
    { signal: controller.signal },
  );
});

test("nothing is written outside dest for any refused archive", async (t) => {
  const ws = workspace(t);
  const hostile = [
    [{ name: "pkg/../evil", content: "x" }],
    [{ name: "../evil", content: "x" }],
    [{ name: "pkg/link", type: "symlink", link: "../.." }],
    [
      { name: "pkg/x/", type: "dir" },
      { name: "pkg/x/up", type: "symlink", link: ".." },
      { name: "pkg/escape", type: "symlink", link: "x/up/.." },
      { name: "pkg/escape/evil", content: "x" },
    ],
    [
      { name: "pkg/alias", type: "symlink", link: "." },
      { name: "pkg/alias/evil", content: "x" },
    ],
    [{ name: "pkg/copy", type: "hardlink", link: "../evil" }],
    [{ name: "pkg/dev", type: "char" }],
  ];
  const dests = [];
  for (const entries of hostile) {
    const before = new Set(fs.readdirSync(ws.parent));
    await assert.rejects(ws.unpack(tarGz(entries)));
    dests.push(...fs.readdirSync(ws.parent).filter((name) => !before.has(name)));
  }
  // Only the archives and the destination folders sit in the parent, and every
  // unpacked path is a real path below its destination.
  for (const name of fs.readdirSync(ws.parent))
    assert.match(name, /^(archive|dest)-\d+(\.tar\.gz)?$/);
  for (const name of dests.filter((n) => n.startsWith("dest-"))) {
    const dest = path.join(ws.parent, name);
    // Walked by hand: a recursive readdir would follow the links unpacked before the
    // refusal.
    const walk = (folder) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) continue;
        assert.ok(fs.realpathSync(full).startsWith(dest + path.sep));
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(dest);
  }
  assert.equal(fs.existsSync(path.join(ws.parent, "evil")), false);
});
