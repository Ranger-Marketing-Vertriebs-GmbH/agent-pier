import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { runFileOperation } from "../helpers/file-explorer.js";
import {
  filenameFileSystem,
  platformCommand,
  privilegedPlatformCommand,
  secondFileSystem,
  setFileSystemReadOnly,
} from "../helpers/file-platform.js";

const required = process.env.AGENTPIER_FILE_FS_MATRIX === "1";
const matrix = { skip: required ? false : "set AGENTPIER_FILE_FS_MATRIX=1" };

async function missing(file) {
  await assert.rejects(fs.lstat(file), { code: "ENOENT" });
}

async function independentMetadata(file) {
  const stat = await fs.stat(file);
  if (process.platform === "darwin") {
    await platformCommand("xattr", ["-wx", "user.agentpier.matrix", "0001ff11", file]);
    await platformCommand("chmod", ["+a", "everyone allow readattr,readextattr", file]);
    return {
      mode: stat.mode & 0o777,
      uid: stat.uid,
      gid: stat.gid,
      xattr: (
        await platformCommand("xattr", ["-px", "user.agentpier.matrix", file])
      ).stdout
        .replace(/\s/g, "")
        .toLowerCase(),
      acl: (await platformCommand("ls", ["-lde", file])).stdout
        .split("\n")
        .slice(1)
        .filter(Boolean),
    };
  }
  await platformCommand("setfattr", [
    "-n",
    "user.agentpier.matrix",
    "-v",
    "0x0001ff11",
    file,
  ]);
  await platformCommand("setfacl", ["-m", `u:${process.getuid()}:rw`, file]);
  return {
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
    xattr: (
      await platformCommand("getfattr", [
        "--only-values",
        "-n",
        "user.agentpier.matrix",
        file,
      ])
    ).stdout.trim(),
    acl: (await platformCommand("getfacl", ["-cp", file])).stdout
      .split("\n")
      .filter((line) => line && !line.startsWith("#")),
  };
}

async function observeMetadata(file) {
  const stat = await fs.stat(file);
  if (process.platform === "darwin")
    return {
      mode: stat.mode & 0o777,
      uid: stat.uid,
      gid: stat.gid,
      xattr: (
        await platformCommand("xattr", ["-px", "user.agentpier.matrix", file])
      ).stdout
        .replace(/\s/g, "")
        .toLowerCase(),
      acl: (await platformCommand("ls", ["-lde", file])).stdout
        .split("\n")
        .slice(1)
        .filter(Boolean),
    };
  return {
    mode: stat.mode & 0o777,
    uid: stat.uid,
    gid: stat.gid,
    xattr: (
      await platformCommand("getfattr", [
        "--only-values",
        "-n",
        "user.agentpier.matrix",
        file,
      ])
    ).stdout.trim(),
    acl: (await platformCommand("getfacl", ["-cp", file])).stdout
      .split("\n")
      .filter((line) => line && !line.startsWith("#")),
  };
}

test(
  "second filesystem has a distinct owned device and idempotent cleanup",
  matrix,
  async (t) => {
    const second = await secondFileSystem(t);
    assert.notEqual(
      (await fs.stat(second.directory)).dev,
      (await fs.stat(t.mock ? "/" : process.cwd())).dev,
    );
    await fs.writeFile(path.join(second.directory, "owned"), "fixture");
    await second.dispose();
    await second.dispose();
    await missing(second.directory);
  },
);

test(
  "actual EXDEV move preserves metadata on Darwin and retains Linux source",
  matrix,
  async (t) => {
    const f = await applicationFixture(t);
    const second = await secondFileSystem(t);
    const source = path.join(second.directory, "move-source.bin");
    const target = path.join(f.home, "move-target");
    await fs.mkdir(target);
    await fs.writeFile(source, Buffer.from([0, 1, 2, 255]), { mode: 0o640 });
    const before = await independentMetadata(source);
    const job = await runFileOperation(f, {
      kind: "move",
      sources: [source],
      target,
    });
    const destination = path.join(target, path.basename(source));
    if (process.platform === "linux") {
      assert.equal(job.status, "failed", JSON.stringify(job));
      assert.equal(job.issue.code, "FILE_METADATA_UNSUPPORTED");
      assert.deepEqual(await fs.readFile(source), Buffer.from([0, 1, 2, 255]));
      await missing(destination);
    } else {
      assert.equal(job.status, "completed", JSON.stringify(job));
      await missing(source);
      assert.deepEqual(await fs.readFile(destination), Buffer.from([0, 1, 2, 255]));
      assert.deepEqual(await observeMetadata(destination), before);
    }
  },
);

test(
  "Linux hidden trusted xattr forces strict retention under ordinary ownership",
  {
    skip: required
      ? process.platform === "linux"
        ? false
        : "Linux trusted namespace only"
      : "set AGENTPIER_FILE_FS_MATRIX=1",
  },
  async (t) => {
    const f = await applicationFixture(t);
    const volume = await filenameFileSystem(t, { caseSensitive: true, sizeMiB: 64 });
    const source = path.join(volume.directory, "hidden-xattr.txt");
    const target = path.join(f.home, "hidden-target");
    await fs.mkdir(target);
    await fs.writeFile(source, "hidden metadata", { mode: 0o640 });
    await privilegedPlatformCommand("setfattr", [
      "-n",
      "trusted.agentpier-matrix",
      "-v",
      "hidden-sentinel",
      source,
    ]);
    assert.equal(
      (
        await privilegedPlatformCommand("getfattr", [
          "--only-values",
          "-n",
          "trusted.agentpier-matrix",
          source,
        ])
      ).stdout.trim(),
      "hidden-sentinel",
    );
    await assert.rejects(
      platformCommand("getfattr", [
        "--only-values",
        "-n",
        "trusted.agentpier-matrix",
        source,
      ]),
    );
    const job = await runFileOperation(f, {
      kind: "move",
      sources: [source],
      target,
    });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.equal(job.issue.code, "FILE_METADATA_UNSUPPORTED");
    assert.equal(await fs.readFile(source, "utf8"), "hidden metadata");
    await missing(path.join(target, path.basename(source)));
    assert.equal(
      (
        await privilegedPlatformCommand("getfattr", [
          "--only-values",
          "-n",
          "trusted.agentpier-matrix",
          source,
        ])
      ).stdout.trim(),
      "hidden-sentinel",
    );
  },
);

test(
  "actual cross-device Trash is reversible or refuses before source removal",
  matrix,
  async (t) => {
    const f = await applicationFixture(t);
    const second = await secondFileSystem(t);
    const source = path.join(second.directory, "trash-source.txt");
    await fs.writeFile(source, "cross-device", { mode: 0o640 });
    const before = await independentMetadata(source);
    const trashed = await runFileOperation(f, { kind: "trash", sources: [source] });
    if (process.platform === "linux") {
      assert.equal(trashed.status, "failed", JSON.stringify(trashed));
      assert.equal(trashed.issue.code, "FILE_METADATA_UNSUPPORTED");
      assert.equal(await fs.readFile(source, "utf8"), "cross-device");
      return;
    }
    assert.equal(trashed.status, "completed", JSON.stringify(trashed));
    await missing(source);
    const response = await f.request("/api/files/trash");
    assert.equal(response.status, 200);
    const entries = (await response.json()).entries;
    assert.equal(entries.length, 1);
    const restored = await runFileOperation(f, {
      kind: "restore",
      sources: [entries[0].id],
      target: source,
    });
    assert.equal(restored.status, "completed", JSON.stringify(restored));
    assert.equal(await fs.readFile(source, "utf8"), "cross-device");
    assert.deepEqual(await observeMetadata(source), before);
  },
);

test(
  "readonly owned mount serves bytes and rejects physical mutation",
  matrix,
  async (t) => {
    const f = await applicationFixture(t);
    const volume = await filenameFileSystem(t, { caseSensitive: true, sizeMiB: 64 });
    const file = path.join(volume.directory, "readonly.bin");
    const bytes = Buffer.from([7, 0, 8, 255]);
    await fs.writeFile(file, bytes);
    await setFileSystemReadOnly(volume, true);
    await assert.rejects(
      fs.writeFile(path.join(volume.directory, "blocked"), "x"),
      (error) => ["EROFS", "EACCES", "EPERM"].includes(error.code),
    );
    const response = await f.request(
      `/api/files/download?path=${encodeURIComponent(file)}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const job = await runFileOperation(f, {
      kind: "create_file",
      target: volume.directory,
      name: "blocked.txt",
    });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.equal(
      ["FILE_READ_ONLY", "FILE_ACCESS_DENIED", "FILE_IO_ERROR"].includes(job.issue.code),
      true,
    );
    assert.deepEqual(await fs.readFile(file), bytes);
  },
);

test(
  "bounded owned filesystem reports real ENOSPC without publishing partial output",
  matrix,
  async (t) => {
    const f = await applicationFixture(t);
    const volume = await filenameFileSystem(t, { caseSensitive: true, sizeMiB: 64 });
    const source = path.join(f.home, "capacity-source.bin");
    await fs.writeFile(source, Buffer.alloc(4 * 1024 * 1024, 0x5a));
    const filler = await fs.open(path.join(volume.directory, "filler"), "wx");
    let full = false;
    try {
      const chunk = Buffer.alloc(1024 * 1024, 0xa5);
      for (let written = 0; written < 96 * 1024 * 1024; written += chunk.length) {
        try {
          await filler.write(chunk);
          await filler.sync();
        } catch (error) {
          assert.equal(error.code, "ENOSPC");
          full = true;
          break;
        }
      }
    } finally {
      await filler.close();
    }
    assert.equal(full, true, "the private bounded volume must reach ENOSPC");
    const job = await runFileOperation(f, {
      kind: "copy",
      sources: [source],
      target: volume.directory,
    });
    assert.equal(job.status, "failed", JSON.stringify(job));
    assert.equal(
      await fs.readFile(source).then((value) => value.length),
      4 * 1024 * 1024,
    );
    await missing(path.join(volume.directory, path.basename(source)));
  },
);
