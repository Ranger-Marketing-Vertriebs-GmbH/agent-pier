import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import yazl from "yazl";
import { tarGz } from "../helpers/tar-fixture.js";
import {
  installReaComponent,
  managedReaComponent,
  reaComponentIds,
  removeReaComponent,
  sweepReaComponents,
} from "../../server/features/tools/rea-components.js";
import { run as realRun } from "../../server/features/tools/tool-run.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const ghidraVersion = "12.1.4";
const jdkVersion = "21.0.13+9";
const macDecompiler = "Ghidra/Features/Decompiler/os/mac_arm_64/decompile";
const linuxDecompiler = "Ghidra/Features/Decompiler/os/linux_x86_64/decompile";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// A Homebrew-bottle-shaped Ghidra: application.properties and the native decompiler.
function ghidraBottle({
  version = ghidraVersion,
  decompiler = true,
  properties = true,
} = {}) {
  const base = `ghidra/${ghidraVersion}/libexec`;
  return tarGz([
    { name: "ghidra/", type: "dir" },
    ...(properties
      ? [
          {
            name: `${base}/Ghidra/application.properties`,
            content: `application.name=Ghidra\napplication.version=${version}\n`,
          },
        ]
      : []),
    { name: `${base}/ghidraRun`, content: "#!/bin/sh\n", mode: 0o755 },
    ...(decompiler
      ? [{ name: `${base}/${macDecompiler}`, content: "#!/bin/sh\n", mode: 0o755 }]
      : []),
  ]);
}

// A Temurin-shaped JDK whose java reports `version` the way OpenJDK does (stderr).
const jdkArchive = (version = jdkVersion) =>
  tarGz([
    {
      name: "jdk-21.0.13+9/bin/java",
      content: `#!/bin/sh\necho 'OpenJDK Runtime Environment Temurin-${version}' >&2\n`,
      mode: 0o755,
    },
    { name: "jdk-21.0.13+9/release", content: `JAVA_VERSION="21.0.13"\n` },
  ]);

// The official Linux release zip of Ghidra.
function ghidraZip() {
  return new Promise((resolve) => {
    const zip = new yazl.ZipFile();
    const top = `ghidra_${ghidraVersion}_PUBLIC`;
    zip.addBuffer(
      Buffer.from(`application.version=${ghidraVersion}\n`),
      `${top}/Ghidra/application.properties`,
      { mode: 0o100644 },
    );
    zip.addBuffer(Buffer.from("#!/bin/sh\n"), `${top}/${linuxDecompiler}`, {
      mode: 0o100755,
    });
    const chunks = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

const ghidraEntry = (bytes, name = "a") => ({
  kind: "tar.gz",
  top: "ghidra",
  installDir: `ghidra/${ghidraVersion}/libexec`,
  decompiler: macDecompiler,
  url: `https://ghcr.io/v2/homebrew/core/ghidra/blobs/sha256:${name}`,
  sha256: sha(bytes),
  size: bytes.length,
  auth: "ghcr-anonymous",
});
const linuxGhidraEntry = (bytes) => ({
  kind: "zip",
  top: `ghidra_${ghidraVersion}_PUBLIC`,
  installDir: `ghidra_${ghidraVersion}_PUBLIC`,
  decompiler: linuxDecompiler,
  url: `https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${ghidraVersion}_build/ghidra.zip`,
  sha256: sha(bytes),
  size: bytes.length,
});
const jdkEntry = (bytes, name = "jdk.tar.gz") => ({
  top: "jdk-21.0.13+9",
  home: "jdk-21.0.13+9",
  url: `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/${name}`,
  sha256: sha(bytes),
  size: bytes.length,
});

async function fixture(t) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rea-comp-")));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, "clis");
  fs.mkdirSync(root);
  const served = new Map();
  // The local stand-in for ghcr.io and github.com: no test reaches the network.
  const server = http.createServer((req, res) => {
    const bytes = served.get(req.url);
    if (!bytes) return res.writeHead(404).end();
    res.writeHead(200, { "content-length": bytes.length }).end(bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const local = `http://127.0.0.1:${server.address().port}`;
  const fetchImpl = (url, options) => {
    const target = new URL(url);
    return fetch(`${local}/${target.hostname}${target.pathname}`, options);
  };
  const serve = (entry, bytes) => {
    const url = new URL(entry.url);
    served.set(`/${url.hostname}${url.pathname}`, bytes);
  };
  const calls = [];
  // Records every command; ldd answers from `ldd`, xattr is a no-op, the rest runs.
  const runner =
    ({ ldd = "", xattr = "" } = {}) =>
    async (command, args, env, cwd, signal, timeout) => {
      calls.push([command, ...args]);
      if (command === "ldd") return ldd;
      if (command === "/usr/bin/xattr") return xattr;
      return realRun(command, args, env, cwd, signal, timeout);
    };
  const install = (id, entry, bytes, options = {}) => {
    serve(entry, bytes);
    return installReaComponent({
      root,
      id,
      version: id === "rea-ghidra" ? ghidraVersion : jdkVersion,
      entry,
      fetchImpl,
      run: runner(),
      platform: "darwin",
      ...options,
    });
  };
  const packages = () =>
    fs.existsSync(path.join(root, ".packages"))
      ? fs.readdirSync(path.join(root, ".packages")).sort()
      : [];
  return { dataDir, root, install, runner, calls, packages, fetchImpl, serve };
}

test("installs Ghidra, checks its version and switches the link atomically", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(reaComponentIds, ["rea-ghidra", "rea-jdk"]);
  const bytes = ghidraBottle();
  const messages = [];
  const installed = await f.install("rea-ghidra", ghidraEntry(bytes), bytes, {
    progress: (message) => messages.push(message),
  });
  const managed = managedReaComponent(f.root, "rea-ghidra");
  assert.equal(managed.version, ghidraVersion);
  assert.equal(
    managed.home,
    fs.realpathSync(path.join(managed.directory, "ghidra/12.1.4/libexec")),
  );
  assert.deepEqual(installed, managed);
  assert.match(path.basename(managed.directory), /^rea-ghidra-[0-9a-f-]{36}$/);
  assert.equal(path.dirname(managed.directory), path.join(f.root, ".packages"));
  assert.ok(fs.lstatSync(path.join(f.root, "rea-ghidra")).isSymbolicLink());
  assert.ok(!path.isAbsolute(fs.readlinkSync(path.join(f.root, "rea-ghidra"))));
  const record = JSON.parse(
    fs.readFileSync(path.join(managed.directory, "agentpier-rea.json"), "utf8"),
  );
  assert.deepEqual(record, {
    id: "rea-ghidra",
    version: ghidraVersion,
    platform: "darwin",
    home: "ghidra/12.1.4/libexec",
  });
  assert.ok(messages.includes(serverMessages.rea.downloading("Ghidra", 0)));
  assert.ok(messages.includes(serverMessages.rea.downloading("Ghidra", 100)));
  assert.deepEqual(
    fs.readdirSync(f.root).filter((name) => name.startsWith(".")),
    [".packages"],
  );
  assert.equal(managedReaComponent(f.root, "rea-jdk"), null);
});

test("installs the JDK and checks the version java reports", async (t) => {
  const f = await fixture(t);
  const bytes = jdkArchive();
  await f.install("rea-jdk", jdkEntry(bytes), bytes, { platform: "linux" });
  const managed = managedReaComponent(f.root, "rea-jdk");
  assert.equal(managed.version, jdkVersion);
  assert.equal(managed.home, path.join(managed.directory, "jdk-21.0.13+9"));
  const java = f.calls.find(([command]) => command.endsWith("/bin/java"));
  assert.deepEqual(java, [path.join(managed.home, "bin/java"), "-version"]);
});

test("a JDK that reports another version is refused and nothing is published", async (t) => {
  const f = await fixture(t);
  const bytes = jdkArchive("21.0.12+7");
  await assert.rejects(f.install("rea-jdk", jdkEntry(bytes), bytes), {
    message: serverMessages.rea.jdkVersionMismatch(jdkVersion),
  });
  assert.equal(managedReaComponent(f.root, "rea-jdk"), null);
  assert.equal(fs.existsSync(path.join(f.root, "rea-jdk")), false);
  assert.deepEqual(f.packages(), []);
  assert.deepEqual(fs.readdirSync(f.root), [".packages"]);
});

test("Ghidra with another version is refused", async (t) => {
  const f = await fixture(t);
  const bytes = ghidraBottle({ version: "12.0" });
  await assert.rejects(f.install("rea-ghidra", ghidraEntry(bytes), bytes), {
    message: serverMessages.rea.ghidraVersionMismatch(ghidraVersion),
  });
  assert.deepEqual(f.packages(), []);
});

test("Ghidra without application.properties has an unexpected layout", async (t) => {
  const f = await fixture(t);
  const bytes = ghidraBottle({ properties: false });
  await assert.rejects(f.install("rea-ghidra", ghidraEntry(bytes), bytes), {
    message: serverMessages.rea.layoutInvalid("Ghidra"),
  });
  assert.deepEqual(f.packages(), []);
});

test("a JDK whose version only starts with the pinned one is refused", async (t) => {
  const f = await fixture(t);
  const bytes = jdkArchive(`${jdkVersion}1`);
  await assert.rejects(f.install("rea-jdk", jdkEntry(bytes), bytes), {
    message: serverMessages.rea.jdkVersionMismatch(jdkVersion),
  });
  assert.deepEqual(f.packages(), []);
});

test("an abort during the library check stops the install", async (t) => {
  const f = await fixture(t);
  const bytes = await ghidraZip();
  const controller = new AbortController();
  const shutdown = Object.assign(Error(serverMessages.tools.installationShutdown), {
    status: 409,
  });
  await assert.rejects(
    f.install("rea-ghidra", linuxGhidraEntry(bytes), bytes, {
      platform: "linux",
      signal: controller.signal,
      run: async () => {
        controller.abort();
        throw shutdown;
      },
    }),
    (error) => error === shutdown,
  );
  assert.equal(managedReaComponent(f.root, "rea-ghidra"), null);
  assert.deepEqual(f.packages(), []);
});

test("an old version that cannot be pruned is logged, not a failed install", async (t) => {
  const f = await fixture(t);
  const bytes = jdkArchive();
  await f.install("rea-jdk", jdkEntry(bytes, "one.tar.gz"), bytes);
  const first = managedReaComponent(f.root, "rea-jdk").directory;
  await f.install("rea-jdk", jdkEntry(bytes, "two.tar.gz"), bytes);
  const original = fsp.rm;
  const rm = mock.method(fsp, "rm", (target, options) =>
    target === first
      ? Promise.reject(Object.assign(Error("busy"), { code: "EBUSY" }))
      : original(target, options),
  );
  const warn = mock.method(console, "warn", () => {});
  t.after(() => {
    rm.mock.restore();
    warn.mock.restore();
  });
  const third = await f.install("rea-jdk", jdkEntry(bytes, "three.tar.gz"), bytes);
  assert.deepEqual(managedReaComponent(f.root, "rea-jdk"), third);
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(fs.existsSync(first));
});

test("Ghidra without the decompiler is refused", async (t) => {
  const f = await fixture(t);
  const bytes = ghidraBottle({ decompiler: false });
  await assert.rejects(f.install("rea-ghidra", ghidraEntry(bytes), bytes), {
    message: serverMessages.rea.ghidraDecompilerMissing,
  });
  assert.equal(managedReaComponent(f.root, "rea-ghidra"), null);
  assert.deepEqual(f.packages(), []);
});

test("on Linux a decompiler with unresolved libraries names them", async (t) => {
  const f = await fixture(t);
  const bytes = await ghidraZip();
  const ldd =
    "\tlibx.so => not found\n\tliby.so => not found\n\tlibc.so.6 => /lib/libc.so.6\n";
  await assert.rejects(
    f.install("rea-ghidra", linuxGhidraEntry(bytes), bytes, {
      platform: "linux",
      run: f.runner({ ldd }),
    }),
    { message: serverMessages.rea.ghidraMissingLibraries("libx.so, liby.so") },
  );
  assert.deepEqual(f.packages(), []);
  const call = f.calls.find(([command]) => command === "ldd");
  assert.ok(call[1].endsWith(`ghidra_${ghidraVersion}_PUBLIC/${linuxDecompiler}`));
});

test("on Linux the official Ghidra zip installs when every library resolves", async (t) => {
  const f = await fixture(t);
  const bytes = await ghidraZip();
  await f.install("rea-ghidra", linuxGhidraEntry(bytes), bytes, {
    platform: "linux",
    run: f.runner({ ldd: "\tlibc.so.6 => /lib/libc.so.6\n" }),
  });
  const managed = managedReaComponent(f.root, "rea-ghidra");
  assert.equal(
    managed.home,
    path.join(managed.directory, `ghidra_${ghidraVersion}_PUBLIC`),
  );
  assert.equal(
    f.calls.some(([command]) => command === "/usr/bin/xattr"),
    false,
  );
});

test("on macOS the unpacked folder loses quarantine attributes (xattr -cr)", async (t) => {
  const f = await fixture(t);
  const bytes = ghidraBottle();
  await f.install("rea-ghidra", ghidraEntry(bytes), bytes);
  const managed = managedReaComponent(f.root, "rea-ghidra");
  assert.deepEqual(
    f.calls.filter(([command]) => command === "/usr/bin/xattr"),
    [["/usr/bin/xattr", "-cr", managed.directory]],
  );
  assert.equal(
    f.calls.some(([command]) => command === "ldd"),
    false,
  );
});

test("an update keeps the previous version until the next install, then prunes it", async (t) => {
  const f = await fixture(t);
  const one = jdkArchive();
  await f.install("rea-jdk", jdkEntry(one, "one.tar.gz"), one);
  const first = managedReaComponent(f.root, "rea-jdk").directory;
  const ghidra = ghidraBottle();
  await f.install("rea-ghidra", ghidraEntry(ghidra), ghidra);
  const ghidraDirectory = managedReaComponent(f.root, "rea-ghidra").directory;
  const two = jdkArchive();
  await f.install("rea-jdk", jdkEntry(two, "two.tar.gz"), two);
  const second = managedReaComponent(f.root, "rea-jdk").directory;
  assert.notEqual(second, first);
  assert.ok(fs.existsSync(first), "the previous version stays for running sessions");
  await f.install("rea-jdk", jdkEntry(one, "three.tar.gz"), one);
  const third = managedReaComponent(f.root, "rea-jdk").directory;
  assert.equal(fs.existsSync(first), false);
  assert.ok(fs.existsSync(second));
  assert.deepEqual(
    f.packages(),
    [path.basename(ghidraDirectory), path.basename(second), path.basename(third)].sort(),
  );
});

test("a failed install keeps the previous version active and leaves no version folder", async (t) => {
  const f = await fixture(t);
  const good = jdkArchive();
  await f.install("rea-jdk", jdkEntry(good, "good.tar.gz"), good);
  const before = managedReaComponent(f.root, "rea-jdk");
  const wrong = jdkArchive("17.0.1+1");
  await assert.rejects(f.install("rea-jdk", jdkEntry(wrong, "bad.tar.gz"), wrong), {
    message: serverMessages.rea.jdkVersionMismatch(jdkVersion),
  });
  assert.deepEqual(managedReaComponent(f.root, "rea-jdk"), before);
  assert.deepEqual(f.packages(), [path.basename(before.directory)]);
  assert.deepEqual(fs.readdirSync(f.root).sort(), [".packages", "rea-jdk"]);
  // A checksum failure behaves the same.
  const entry = { ...jdkEntry(good, "tampered.tar.gz"), sha256: "0".repeat(64) };
  await assert.rejects(f.install("rea-jdk", entry, good), {
    message: serverMessages.rea.checksumMismatch,
  });
  assert.deepEqual(managedReaComponent(f.root, "rea-jdk"), before);
  assert.deepEqual(fs.readdirSync(f.root).sort(), [".packages", "rea-jdk"]);
});

test("a full disk reports rea.diskFull", async (t) => {
  const f = await fixture(t);
  const bytes = jdkArchive();
  const full = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(Object.assign(Error("no space"), { code: "ENOSPC" }));
        },
      }),
      { status: 200 },
    );
  await assert.rejects(
    installReaComponent({
      root: f.root,
      id: "rea-jdk",
      version: jdkVersion,
      entry: jdkEntry(bytes),
      fetchImpl: async () => full(),
      run: f.runner(),
      platform: "darwin",
    }),
    { message: serverMessages.rea.diskFull },
  );
  assert.deepEqual(fs.readdirSync(f.root), [".packages"]);
  assert.deepEqual(f.packages(), []);
});

test("a full disk while the Ghidra zip unpacks reports rea.diskFull", async (t) => {
  const f = await fixture(t);
  const bytes = await ghidraZip();
  const original = fs.createWriteStream;
  const writes = mock.method(fs, "createWriteStream", (file, options) => {
    if (String(file).includes(`${path.sep}.packages${path.sep}`)) {
      const stream = original(file, options);
      queueMicrotask(() =>
        stream.destroy(Object.assign(Error("no space"), { code: "EDQUOT" })),
      );
      return stream;
    }
    return original(file, options);
  });
  t.after(() => writes.mock.restore());
  await assert.rejects(
    f.install("rea-ghidra", linuxGhidraEntry(bytes), bytes, { platform: "linux" }),
    { message: serverMessages.rea.diskFull },
  );
  assert.deepEqual(f.packages(), []);
});

test("sweep removes work folders, stray links and unpublished versions only", async (t) => {
  const f = await fixture(t);
  const bytes = jdkArchive();
  await f.install("rea-jdk", jdkEntry(bytes), bytes);
  const active = managedReaComponent(f.root, "rea-jdk");
  const packages = path.join(f.root, ".packages");
  fs.mkdirSync(path.join(f.root, ".rea-install-abc"));
  fs.writeFileSync(path.join(f.root, ".rea-install-abc", "archive"), "partial");
  // Another installer's work folder may be in flight; it is not REA's to sweep.
  fs.mkdirSync(path.join(f.root, ".install-x"));
  fs.symlinkSync("x", path.join(f.root, ".rea-jdk-link-1234"));
  fs.symlinkSync("x", path.join(f.root, ".rea-ghidra-link-5678"));
  fs.mkdirSync(path.join(packages, "rea-ghidra-unpublished"));
  fs.mkdirSync(path.join(packages, "rea-jdk-unpublished"));
  fs.mkdirSync(path.join(packages, "chromium-foreign"));
  fs.mkdirSync(path.join(packages, "rea-jdk-kept"));
  fs.writeFileSync(path.join(packages, "rea-jdk-kept", "agentpier-rea.json"), "{}");
  fs.symlinkSync("x", path.join(f.root, ".chromium-foreign"));
  sweepReaComponents(f.root);
  assert.deepEqual(fs.readdirSync(f.root).sort(), [
    ".chromium-foreign",
    ".install-x",
    ".packages",
    "rea-jdk",
  ]);
  assert.deepEqual(
    f.packages(),
    ["chromium-foreign", path.basename(active.directory), "rea-jdk-kept"].sort(),
  );
  assert.deepEqual(managedReaComponent(f.root, "rea-jdk"), active);
  sweepReaComponents(path.join(f.dataDir, "missing"));
});

test("remove deletes the link and every version folder of that component only", async (t) => {
  const f = await fixture(t);
  const jdk = jdkArchive();
  await f.install("rea-jdk", jdkEntry(jdk, "one.tar.gz"), jdk);
  await f.install("rea-jdk", jdkEntry(jdk, "two.tar.gz"), jdk);
  const ghidra = ghidraBottle();
  await f.install("rea-ghidra", ghidraEntry(ghidra), ghidra);
  const kept = managedReaComponent(f.root, "rea-ghidra");
  fs.mkdirSync(path.join(f.root, ".packages", "chromium-other"));
  await removeReaComponent(f.root, "rea-jdk");
  assert.equal(managedReaComponent(f.root, "rea-jdk"), null);
  assert.equal(fs.existsSync(path.join(f.root, "rea-jdk")), false);
  assert.deepEqual(
    f.packages(),
    ["chromium-other", path.basename(kept.directory)].sort(),
  );
  assert.deepEqual(managedReaComponent(f.root, "rea-ghidra"), kept);
  // Removing what is not installed is a no-op.
  await removeReaComponent(f.root, "rea-jdk");
});

test("a link or record pointing elsewhere is not a managed component", async (t) => {
  const f = await fixture(t);
  const bytes = jdkArchive();
  await f.install("rea-jdk", jdkEntry(bytes), bytes);
  const managed = managedReaComponent(f.root, "rea-jdk");
  const record = path.join(managed.directory, "agentpier-rea.json");
  const original = fs.readFileSync(record, "utf8");
  fs.chmodSync(record, 0o600);
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(original), home: "../.." }));
  assert.equal(managedReaComponent(f.root, "rea-jdk"), null);
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(original), id: "rea-ghidra" }));
  assert.equal(managedReaComponent(f.root, "rea-jdk"), null);
  fs.writeFileSync(record, original);
  assert.deepEqual(managedReaComponent(f.root, "rea-jdk"), managed);
  fs.unlinkSync(path.join(f.root, "rea-jdk"));
  fs.symlinkSync(f.dataDir, path.join(f.root, "rea-jdk"));
  assert.equal(managedReaComponent(f.root, "rea-jdk"), null);
  assert.equal(managedReaComponent(f.root, "rea-unknown"), null);
});
