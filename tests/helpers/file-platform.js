import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

export const platformCommand = (command, args) =>
  promisify(execFile)(command, args, {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
const privileged = (command, args) =>
  process.getuid() === 0
    ? platformCommand(command, args)
    : platformCommand("sudo", ["-n", command, ...args]);

// Opt-in integration fixtures only; setup failures in required mode are failures.
// Every command targets this newly allocated image/mount. Never infer disk numbers.
export async function filenameFileSystem(t, { caseSensitive = true } = {}) {
  assert.equal(process.env.AGENTPIER_FILE_FS_MATRIX, "1");
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-fs-")),
  );
  const directory = path.join(root, "mount"),
    image = path.join(root, "image.sparseimage");
  await fs.mkdir(directory, { mode: 0o700 });
  let device, identity;
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
  t.after(async () => {
    if (process.platform === "darwin") {
      const current = await attached();
      if (current) {
        const entity =
          current["system-entities"].find((item) => item["mount-point"] === directory) ||
          current["system-entities"].find((item) => item["dev-entry"]);
        assert.ok(
          entity?.["dev-entry"],
          "retain fixture when the attached device cannot be proved",
        );
        if (identity && entity["mount-point"])
          assert.equal(String((await fs.stat(directory)).dev), identity);
        await platformCommand("hdiutil", ["detach", entity["dev-entry"]]);
      }
      assert.equal(await attached(), undefined);
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
  });
  if (process.platform === "darwin") {
    await platformCommand("hdiutil", [
      "create",
      "-size",
      "256m",
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
      await file.truncate(256 * 1024 * 1024);
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
  return { directory, root, device, identity, caseSensitive };
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
