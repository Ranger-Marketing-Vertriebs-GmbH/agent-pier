import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const platformCommand = (command, args) =>
  promisify(execFile)(command, args, {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
const privileged = (command, args) =>
  process.getuid() === 0
    ? platformCommand(command, args)
    : platformCommand("sudo", ["-n", command, ...args]);
export const privilegedPlatformCommand = privileged;

// hdiutil may temporarily retain an APFS image after unmounting its volume; on
// macOS runners the whole disk has stayed busy for more than four seconds after a
// clean unmount. Re-observe only this fixture's image on every attempt; never
// force an eject.
export async function detachOwnedDiskImage({
  image,
  directory,
  identity,
  attached,
  command = platformCommand,
  stat = fs.stat,
  wait = delay,
  diagnostic,
}) {
  const delays = [250, 500, 1000, 2000, 4000, 8000];
  for (let attempt = 0; ; attempt++) {
    const current = await attached();
    if (!current) return;
    assert.equal(current["image-path"], image);
    const entities = current["system-entities"] || [];
    const mounted = entities.filter((item) => item["mount-point"]);
    assert.ok(mounted.every((item) => item["mount-point"] === directory));
    if (identity && mounted.length)
      assert.equal(String((await stat(directory)).dev), identity);
    const disks = entities.filter(
      (item) => item["content-hint"] === "GUID_partition_scheme",
    );
    assert.equal(disks.length, 1, "retain fixture without a proved whole image disk");
    const device = disks[0]["dev-entry"];
    assert.match(device, /^\/dev\/disk[0-9]+$/);
    try {
      await command("hdiutil", ["detach", device]);
      assert.equal(await attached(), undefined, "retain fixture still attached");
      return;
    } catch (error) {
      diagnostic?.(
        JSON.stringify({
          fixture: "detach-failed",
          image,
          directory,
          device,
          identity,
          attempt: attempt + 1,
          code: error.code,
          stderr: error.stderr,
          entities,
        }),
      );
      // EBUSY is numeric and stable even when hdiutil localizes its stderr.
      if (error.code !== 16 || attempt === delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}

// Opt-in integration fixtures only; setup failures in required mode are failures.
// Every command targets this newly allocated image/mount. Never infer disk numbers.
export async function filenameFileSystem(
  t,
  { caseSensitive = true, sizeMiB = 256 } = {},
) {
  assert.equal(process.env.AGENTPIER_FILE_FS_MATRIX, "1");
  assert.ok(Number.isInteger(sizeMiB) && sizeMiB >= 32 && sizeMiB <= 1024);
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-fs-")),
  );
  const directory = path.join(root, "mount"),
    image = path.join(root, "image.sparseimage");
  await fs.mkdir(directory, { mode: 0o700 });
  let device,
    identity,
    disposed = false;
  const plist = async (value) => {
    const file = path.join(root, "observed.plist");
    await fs.writeFile(file, value, { mode: 0o600 });
    return JSON.parse(
      (await platformCommand("plutil", ["-convert", "json", "-o", "-", file])).stdout,
    );
  };
  const attached = async () => {
    const info = await plist(
      (await platformCommand("hdiutil", ["info", "-plist"])).stdout,
    );
    return info.images?.find((item) => item["image-path"] === image);
  };
  const dispose = async () => {
    if (disposed) return;
    if (process.platform === "darwin") {
      await detachOwnedDiskImage({
        image,
        directory,
        identity,
        attached,
        diagnostic: (value) => t.diagnostic?.(value),
      });
    } else {
      const mounted = await platformCommand("findmnt", [
        "--json",
        "--mountpoint",
        directory,
      ]).catch((error) => {
        if (error.code === 1 && !error.stdout.trim())
          return { stdout: '{"filesystems":[]}' };
        throw error;
      });
      const current = JSON.parse(mounted.stdout).filesystems?.[0];
      if (current) {
        assert.equal(current.source, device);
        if (identity) assert.equal(String((await fs.stat(directory)).dev), identity);
        await privileged("umount", [directory]);
      }
      const loops =
        JSON.parse(
          (await privileged("losetup", ["--json", "--list", "--associated", image]))
            .stdout,
        ).loopdevices || [];
      for (const loop of loops) {
        assert.equal(loop["back-file"], image);
        await privileged("losetup", ["--detach", loop.name]);
      }
    }
    await fs.rm(root, { recursive: true });
    t.diagnostic?.(
      JSON.stringify({
        fixture: "detached-and-removed",
        image,
        directory,
        device,
        identity,
      }),
    );
    disposed = true;
  };
  t.after(dispose);
  if (process.platform === "darwin") {
    await platformCommand("hdiutil", [
      "create",
      "-size",
      `${sizeMiB}m`,
      "-type",
      "SPARSE",
      "-fs",
      caseSensitive ? "Case-sensitive APFS" : "APFS",
      "-volname",
      "AgentPier fixture",
      image,
    ]);
    const result = await platformCommand("hdiutil", [
      "attach",
      image,
      "-nobrowse",
      "-owners",
      "on",
      "-mountpoint",
      directory,
      "-plist",
    ]);
    await fs.writeFile(path.join(root, "attach.plist"), result.stdout, { mode: 0o600 });
    const info = await plist(result.stdout);
    device = info["system-entities"].find((item) => item["mount-point"] === directory)?.[
      "dev-entry"
    ];
    assert.ok(device);
  } else {
    const file = await fs.open(image, "wx", 0o600);
    try {
      await file.truncate(sizeMiB * 1024 * 1024);
    } finally {
      await file.close();
    }
    await platformCommand("mkfs.ext4", [
      "-F",
      "-q",
      "-O",
      "casefold,encrypt",
      "-E",
      "encoding=utf8-12.1",
      image,
    ]);
    device = (await privileged("losetup", ["--find", "--show", image])).stdout.trim();
    assert.match(device, /^\/dev\/loop[0-9]+$/);
    await privileged("mount", ["-t", "ext4", device, directory]);
    await privileged("chown", [`${process.getuid()}:${process.getgid()}`, directory]);
  }
  identity = String((await fs.stat(directory)).dev);
  assert.notEqual(identity, String((await fs.stat(root)).dev));
  await fs.writeFile(
    path.join(root, "identity.json"),
    JSON.stringify({ image, directory, device, identity }),
    { mode: 0o600 },
  );
  t.diagnostic?.(
    JSON.stringify({ fixture: "mounted", image, directory, device, identity }),
  );
  return {
    directory,
    root,
    get device() {
      return device;
    },
    get identity() {
      return identity;
    },
    caseSensitive,
    dispose,
    async setReadOnly(readOnly) {
      assert.equal(String((await fs.stat(directory)).dev), identity);
      if (process.platform === "darwin") {
        const current = await attached();
        const entity = current?.["system-entities"].find(
          (item) => item["mount-point"] === directory,
        );
        assert.equal(entity?.["dev-entry"], device);
        await detachOwnedDiskImage({
          image,
          directory,
          identity,
          attached,
          diagnostic: (value) => t.diagnostic?.(value),
        });
        const result = await platformCommand("hdiutil", [
          "attach",
          image,
          ...(readOnly ? ["-readonly"] : []),
          "-nobrowse",
          "-owners",
          "on",
          "-mountpoint",
          directory,
          "-plist",
        ]);
        const info = await plist(result.stdout);
        device = info["system-entities"].find(
          (item) => item["mount-point"] === directory,
        )?.["dev-entry"];
        assert.ok(device);
      } else
        await privileged("mount", ["-o", `remount,${readOnly ? "ro" : "rw"}`, directory]);
      identity = String((await fs.stat(directory)).dev);
      t.diagnostic?.(
        JSON.stringify({ fixture: readOnly ? "readonly" : "writable", device, identity }),
      );
    },
  };
}

export async function secondFileSystem(t) {
  assert.equal(process.env.AGENTPIER_FILE_FS_MATRIX, "1");
  if (process.platform === "darwin") return filenameFileSystem(t);
  assert.equal(process.platform, "linux", "filesystem matrix supports Linux and Darwin");
  const sharedMemory = await fs.realpath("/dev/shm");
  assert.notEqual(
    (await fs.stat(sharedMemory)).dev,
    (await fs.stat(os.tmpdir())).dev,
    "/dev/shm must be a distinct device in the required Linux matrix",
  );
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(sharedMemory, "agentpier-second-fs-")),
  );
  const identity = String((await fs.stat(directory)).dev);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    assert.equal(String((await fs.stat(directory)).dev), identity);
    await fs.rm(directory, { recursive: true });
    disposed = true;
    t.diagnostic?.(JSON.stringify({ fixture: "removed", directory, identity }));
  };
  t.after(dispose);
  t.diagnostic?.(JSON.stringify({ fixture: "created", directory, identity }));
  return { directory, identity, dispose };
}

export async function setFileSystemReadOnly(volume, readOnly) {
  assert.equal(process.env.AGENTPIER_FILE_FS_MATRIX, "1");
  await volume.setReadOnly(readOnly);
  assert.equal(String((await fs.stat(volume.directory)).dev), volume.identity);
}

export async function filenameParent(volume, name, casefold = false) {
  const directory = path.join(volume.directory, name);
  await fs.mkdir(directory, { mode: 0o700 });
  if (process.platform === "linux") {
    await platformCommand("chattr", [casefold ? "+F" : "-F", directory]);
    const flags = (await platformCommand("lsattr", ["-d", directory])).stdout.split(
      /\s/,
    )[0];
    assert.equal(flags.includes("F"), casefold);
  }
  return directory;
}

export async function encryptedEmptyDirectory(directory) {
  assert.equal(process.platform, "linux");
  const { default: koffi } = await import("koffi");
  const library = koffi.load(null);
  const ioctl = library.func("int ioctl(int fd, unsigned long request, void *value)");
  const handle = await fs.open(directory, "r");
  try {
    // Test-only v1 policy, no key is installed or content stored. Kernel fscrypt
    // documentation permits setting this empty-directory policy without a key.
    // include/uapi/linux/fscrypt.h: _IOR('f',19,fscrypt_policy_v1), size 12.
    const policy = Buffer.concat([Buffer.from([0, 1, 4, 3]), randomBytes(8)]);
    assert.equal(
      ioctl(handle.fd, 0x800c6613, policy),
      0,
      `fscrypt fixture errno ${koffi.errno()}`,
    );
    const flags = Buffer.alloc(8);
    assert.equal(ioctl(handle.fd, 0x80086601, flags), 0);
    assert.ok(flags.readUInt32LE() & 0x800);
  } finally {
    await handle.close();
  }
}
