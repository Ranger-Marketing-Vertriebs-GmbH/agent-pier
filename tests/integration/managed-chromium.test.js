import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import yazl from "yazl";
import { ToolInstaller } from "../../server/features/tools/tool-installer.js";
import {
  chromiumUtility,
  installChromium,
  managedChromium,
} from "../../server/features/tools/chromium-installer.js";
import { detectBrowser } from "../../server/features/assistants/browser-detection.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

// A fake Chrome for Testing archive: a script that answers --version, a library and
// a relative link like the macOS app bundle's framework links.
function archive(version, extra = []) {
  return new Promise((resolve) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(
      // Answers --version, and a real headless start with a page dump.
      Buffer.from(
        `#!/bin/sh\ncase "$*" in *--dump-dom*) echo "<html><head></head><body></body></html>";; *) echo "Google Chrome for Testing ${version}";; esac\n`,
      ),
      "chrome-linux64/chrome",
      { mode: 0o100755 },
    );
    zip.addBuffer(Buffer.from("library"), "chrome-linux64/lib/libfake.so", {
      mode: 0o100644,
    });
    zip.addBuffer(Buffer.from("lib"), "chrome-linux64/Current", { mode: 0o120777 });
    for (const [name, content, mode] of extra)
      zip.addBuffer(Buffer.from(content), name, { mode });
    const chunks = [];
    zip.outputStream.on("data", (c) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}
const manifestFor = (version, bytes, overrides = {}) => ({
  version,
  platforms: {
    linux64: {
      url: `https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-linux64.zip`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      executable: "chrome-linux64/chrome",
      ...overrides,
    },
  },
});

async function fixture(t) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chromium-")));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const served = new Map();
  const requests = [];
  // The local stand-in for storage.googleapis.com: no test reaches the network.
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const bytes = served.get(req.url);
    if (!bytes) return res.writeHead(404).end();
    res.writeHead(200, { "content-length": bytes.length }).end(bytes);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const local = `http://127.0.0.1:${server.address().port}`;
  const chromiumFetch = (url, options) => {
    assert.equal(url.hostname, "storage.googleapis.com");
    return fetch(`${local}${url.pathname}`, options);
  };
  const serve = (manifest, bytes) =>
    served.set(new URL(manifest.platforms.linux64.url).pathname, bytes);
  const installer = (manifest) =>
    new ToolInstaller({
      dataDir,
      home: dataDir,
      npmCli: "/bin/false",
      detect: () => [],
      platform: "linux",
      arch: "x64",
      chromiumFetch,
      manifest,
    });
  const finish = async (tools) => {
    await tools.active?.done;
    return tools.list().installations.find((item) => item.tool === "chromium");
  };
  return {
    dataDir,
    root: path.join(dataDir, "clis"),
    serve,
    installer,
    finish,
    requests,
    local,
  };
}

test("the managed browser installs, verified, and is detected first", async (t) => {
  const f = await fixture(t);
  const bytes = await archive("155.0.0.1");
  const manifest = manifestFor("155.0.0.1", bytes);
  f.serve(manifest, bytes);
  const tools = f.installer(manifest);
  const before = tools.list().installations.find((item) => item.tool === "chromium");
  assert.equal(before.installed, false);
  assert.equal(before.available, true);
  assert.equal(before.installer, "chrome-for-testing");
  tools.start("chromium");
  const after = await f.finish(tools);
  assert.equal(after.status, "succeeded", after.message);
  assert.equal(after.message, serverMessages.tools.chromiumInstalled);
  assert.equal(after.installed, true);
  assert.equal(after.installedVersion, "155.0.0.1");
  assert.equal(after.updateAvailable, false);
  assert.equal(after.removable, true);
  const managed = managedChromium(f.root);
  assert.ok(managed.executable.startsWith(path.join(f.root, ".packages", "chromium-")));
  assert.equal(
    fs.readlinkSync(path.join(managed.directory, "chrome-linux64/Current")),
    "lib",
  );
  assert.equal(chromiumUtility(f.root).installed, true);
  // Detection prefers it over any other browser and counts it as the agents' app.
  const found = detectBrowser({
    platform: "linux",
    exists: (p) => p === managed.executable || p === "/usr/bin/google-chrome",
    env: { DISPLAY: ":0" },
    managed: managed.executable,
  });
  assert.equal(found.executablePath, managed.executable);
  assert.equal(found.managed, true);
  assert.deepEqual(found.visible, { available: true });
  assert.throws(() => tools.start("chromium"), { status: 409 });
});

test("a download that does not match its pinned checksum is never activated", async (t) => {
  const f = await fixture(t);
  const bytes = await archive("155.0.0.1");
  const manifest = manifestFor("155.0.0.1", bytes);
  const altered = Buffer.from(bytes);
  altered[40] ^= 0xff;
  f.serve(manifest, altered);
  const tools = f.installer(manifest);
  tools.start("chromium");
  const job = await f.finish(tools);
  assert.equal(job.status, "failed");
  assert.equal(job.message, serverMessages.tools.chromiumChecksumMismatch);
  assert.equal(managedChromium(f.root), null);
  assert.deepEqual(fs.readdirSync(path.join(f.root, ".packages")), []);
});

test("archive entries that leave the browser folder are refused", async (t) => {
  const unsafe = [serverMessages.tools.unsafeArchivePath];
  for (const [extra, messages = unsafe, patch] of [
    [[["chrome-linux64/escape", "../../outside", 0o120777]]],
    [[["chrome-linux64/abs", "/etc/passwd", 0o120777]]],
    [[["other/file", "x", 0o100644]]],
    // An entry name with "..": yazl refuses one, so the bytes are patched after.
    [
      [["chrome-linux64/XX/evil", "x", 0o100644]],
      [
        serverMessages.tools.unsafeArchivePath,
        serverMessages.tools.chromiumArchiveInvalid,
      ],
      (bytes) =>
        Buffer.from(bytes.toString("latin1").replaceAll("/XX/", "/../"), "latin1"),
    ],
    // Two names that one case-insensitive file system would merge.
    [
      [
        ["chrome-linux64/Dup", "a", 0o100644],
        ["chrome-linux64/dup", "b", 0o100644],
      ],
      [serverMessages.tools.duplicateArchivePaths],
    ],
    // A link unpacked first never redirects a later file below it.
    [
      [
        ["chrome-linux64/redirect", "lib", 0o120777],
        ["chrome-linux64/redirect/planted", "x", 0o100644],
      ],
    ],
    // A chain of links, each inside on its own, that leaves the folder together.
    [
      [
        ["chrome-linux64/p/q/f", "x", 0o100644],
        ["chrome-linux64/p/q/L", "../..", 0o120777],
        ["chrome-linux64/x", "p/q/L/../../..", 0o120777],
      ],
    ],
  ]) {
    const f = await fixture(t);
    let bytes = await archive("155.0.0.1", extra);
    if (patch) bytes = patch(bytes);
    const manifest = manifestFor("155.0.0.1", bytes);
    f.serve(manifest, bytes);
    const tools = f.installer(manifest);
    tools.start("chromium");
    const job = await f.finish(tools);
    assert.equal(job.status, "failed", JSON.stringify(extra));
    assert.ok(
      messages.includes(job.message),
      `${job.message} for ${JSON.stringify(extra)}`,
    );
    assert.equal(managedChromium(f.root), null);
  }
});

test("a newer pinned version updates in place and keeps the previous one", async (t) => {
  const f = await fixture(t);
  const versions = ["155.0.0.1", "155.0.0.2", "155.0.0.3"];
  const packages = [];
  for (const [index, version] of versions.entries()) {
    const bytes = await archive(version);
    const manifest = manifestFor(version, bytes);
    f.serve(manifest, bytes);
    const tools = f.installer(manifest);
    if (index === 0) tools.start("chromium");
    else {
      const ready = tools.list().installations.find((item) => item.tool === "chromium");
      assert.equal(ready.updateAvailable, true);
      assert.equal(chromiumUtility(f.root, manifest).updateAvailable, true);
      tools.startUpdate("chromium");
    }
    const job = await f.finish(tools);
    assert.equal(job.status, "succeeded", job.message);
    assert.equal(job.installedVersion, version);
    packages.push(path.basename(managedChromium(f.root).directory));
    if (index === 2) assert.throws(() => tools.startUpdate("chromium"), { status: 409 });
  }
  // The running browser may still use the previous version; older ones are pruned.
  assert.deepEqual(
    fs.readdirSync(path.join(f.root, ".packages")).sort(),
    packages.slice(1).sort(),
  );
});

test("removing the managed browser deletes it and its versions", async (t) => {
  const f = await fixture(t);
  const bytes = await archive("155.0.0.1");
  const manifest = manifestFor("155.0.0.1", bytes);
  f.serve(manifest, bytes);
  const tools = f.installer(manifest);
  tools.start("chromium");
  await f.finish(tools);
  const removed = await tools.remove("chromium");
  assert.equal(removed.installed, false);
  assert.equal(removed.message, serverMessages.tools.chromiumRemoved);
  assert.equal(fs.existsSync(path.join(f.root, "chromium")), false);
  assert.deepEqual(fs.readdirSync(path.join(f.root, ".packages")), []);
  await assert.rejects(tools.remove("chromium"), { status: 409 });
  await assert.rejects(tools.remove("codex"));
});

test("Linux reports missing shared libraries instead of a browser that cannot start", async (t) => {
  const f = await fixture(t);
  const bytes = await archive("155.0.0.1");
  const manifest = manifestFor("155.0.0.1", bytes);
  f.serve(manifest, bytes);
  fs.mkdirSync(f.root, { recursive: true });
  const run = async (command) =>
    command === "ldd"
      ? "\tlibnss3.so => not found\n\tlibc.so.6 => /lib/libc.so.6\n\tlibgbm.so.1 => not found\n"
      : "Google Chrome for Testing 155.0.0.1";
  await assert.rejects(
    installChromium({
      root: f.root,
      platform: "linux",
      arch: "x64",
      manifest,
      fetchImpl: (url, options) =>
        fetch(url.href.replace("https://storage.googleapis.com", f.local), options),
      run,
    }).catch((error) => {
      throw error;
    }),
    { message: serverMessages.tools.chromiumMissingLibraries("libnss3.so, libgbm.so.1") },
  );
  assert.equal(managedChromium(f.root), null);
});

test("a browser that cannot start explains a blocked Linux sandbox", async (t) => {
  const f = await fixture(t);
  const bytes = await archive("155.0.0.1");
  const manifest = manifestFor("155.0.0.1", bytes);
  f.serve(manifest, bytes);
  fs.mkdirSync(f.root, { recursive: true });
  const starts = [];
  // --version works, a real start aborts like Chrome without a usable sandbox.
  const run = async (command, args) => {
    if (command === "ldd") return "";
    if (!args.includes("--dump-dom")) return "Google Chrome for Testing 155.0.0.1";
    starts.push(args);
    throw Error("No usable sandbox!");
  };
  const install = (userns) =>
    installChromium({
      root: f.root,
      platform: "linux",
      arch: "x64",
      manifest,
      fetchImpl: (url, options) =>
        fetch(url.href.replace("https://storage.googleapis.com", f.local), options),
      run,
      userns: () => userns,
    });
  await assert.rejects(install("1"), {
    message: serverMessages.tools.chromiumSandboxBlocked,
  });
  await assert.rejects(install("0"), {
    message: serverMessages.tools.chromiumNotStarting,
  });
  // A short headless start, never with the sandbox switched off.
  assert.ok(starts[0].includes("--headless=new"));
  assert.ok(starts[0].includes("about:blank"));
  assert.ok(!starts[0].some((arg) => /no-sandbox/.test(arg)));
  assert.equal(managedChromium(f.root), null);
});

test("a full disk is named as such", async (t) => {
  const f = await fixture(t);
  const bytes = await archive("155.0.0.1");
  const manifest = manifestFor("155.0.0.1", bytes);
  f.serve(manifest, bytes);
  fs.mkdirSync(f.root, { recursive: true });
  await assert.rejects(
    installChromium({
      root: f.root,
      platform: "linux",
      arch: "x64",
      manifest,
      fetchImpl: (url, options) =>
        fetch(url.href.replace("https://storage.googleapis.com", f.local), options),
      run: async () => {
        throw Object.assign(Error("write failed"), { code: "ENOSPC" });
      },
    }),
    { message: serverMessages.tools.chromiumDiskFull },
  );
});

test("a platform without a pinned build is explained, not offered", async (t) => {
  const f = await fixture(t);
  const tools = new ToolInstaller({
    dataDir: f.dataDir,
    home: f.dataDir,
    npmCli: "/bin/false",
    detect: () => [],
    platform: "linux",
    arch: "arm64",
    manifest: { version: "1", platforms: {} },
  });
  const row = tools.list().installations.find((item) => item.tool === "chromium");
  assert.equal(row.available, false);
  assert.equal(row.reason, serverMessages.tools.chromiumPlatformUnavailable);
  assert.throws(() => tools.start("chromium"), { status: 409 });
});

test("the managed browser is not removed while the agents use it", async (t) => {
  const f = await fixture(t);
  const bytes = await archive("155.0.0.1");
  const manifest = manifestFor("155.0.0.1", bytes);
  f.serve(manifest, bytes);
  const tools = f.installer(manifest);
  tools.start("chromium");
  await f.finish(tools);
  let used = true;
  tools.chromiumInUse = () => used;
  await assert.rejects(tools.remove("chromium"), {
    status: 409,
    message: serverMessages.tools.chromiumInUse,
  });
  assert.ok(managedChromium(f.root));
  used = false;
  assert.equal((await tools.remove("chromium")).installed, false);
});

test("a server start sweeps what an interrupted install left behind", async (t) => {
  const f = await fixture(t);
  const bytes = await archive("155.0.0.1");
  const manifest = manifestFor("155.0.0.1", bytes);
  f.serve(manifest, bytes);
  const first = f.installer(manifest);
  first.start("chromium");
  await f.finish(first);
  const current = path.basename(managedChromium(f.root).directory);
  const packages = path.join(f.root, ".packages");
  // A crash mid-install: its work folder, an unpublished version, a stray link.
  fs.mkdirSync(path.join(f.root, ".install-crashed"));
  fs.mkdirSync(path.join(packages, "chromium-unpublished", "chrome-linux64"), {
    recursive: true,
  });
  fs.symlinkSync("missing", path.join(f.root, ".chromium-stray"));
  // Another tool's version directory is not the browser's to sweep.
  fs.mkdirSync(path.join(packages, "4d1c6e2a-cli"));
  const restarted = f.installer(manifest);
  restarted.sweepChromium();
  assert.deepEqual(fs.readdirSync(packages).sort(), [current, "4d1c6e2a-cli"].sort());
  assert.equal(fs.existsSync(path.join(f.root, ".install-crashed")), false);
  assert.equal(fs.existsSync(path.join(f.root, ".chromium-stray")), false);
  assert.ok(managedChromium(f.root));
});
