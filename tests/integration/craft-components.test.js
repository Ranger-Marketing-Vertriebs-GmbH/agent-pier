import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import yazl from "yazl";
import { tarGz } from "../helpers/tar-fixture.js";
import {
  installReaComponent,
  managedReaComponent,
  removeReaComponent,
  sweepReaComponents,
} from "../../server/features/tools/rea-components.js";
import {
  craftBinary,
  craftBinaryPath,
} from "../../server/features/tools/craft-manifest.js";
import { run } from "../../server/features/tools/tool-run.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const version = "0.5.0";
const script = (reported = version) =>
  `#!/bin/sh\necho "craft-anything-cli ${reported}"\n`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const release = "https://github.com/storytold/craft-anything/releases/download/v0.5.0";

const zipArchive = (reported) =>
  new Promise((resolve) => {
    const zip = new yazl.ZipFile();
    const top = "craft-anything-cli-0.5.0-macos-universal";
    zip.addBuffer(Buffer.from(script(reported)), `${top}/craft-anything-cli`, {
      mode: 0o100755,
    });
    const chunks = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
const tarArchive = (reported) =>
  tarGz([
    {
      name: "craft-anything-0.5.0-linux-x86_64/bin/craft-anything-cli",
      content: script(reported),
      mode: 0o755,
    },
    {
      name: "craft-anything-0.5.0-linux-x86_64/bin/craft-anything",
      content: "gui",
      mode: 0o755,
    },
  ]);
const zipEntry = (bytes) => ({
  kind: "zip",
  top: "craft-anything-cli-0.5.0-macos-universal",
  binary: "craft-anything-cli",
  url: `${release}/craft-anything-cli-0.5.0-macos-universal.zip`,
  sha256: sha(bytes),
  size: bytes.length,
});
const tarEntry = (bytes, extra = {}) => ({
  kind: "tar.gz",
  top: "craft-anything-0.5.0-linux-x86_64",
  binary: "bin/craft-anything-cli",
  remove: ["bin/craft-anything"],
  url: `${release}/craft-anything-0.5.0-linux-x86_64.tar.gz`,
  sha256: sha(bytes),
  size: bytes.length,
  ...extra,
});

async function fixture(t) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "craft-comp-")));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, "clis");
  fs.mkdirSync(root);
  const served = new Map();
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
  const install = (entry, bytes, options = {}) => {
    const url = new URL(entry.url);
    served.set(`/${url.hostname}${url.pathname}`, bytes);
    return installReaComponent({
      root,
      id: "craft-anything",
      version,
      entry,
      fetchImpl,
      run,
      env: process.env,
      platform: "linux",
      ...options,
    });
  };
  const packages = () =>
    fs.existsSync(path.join(root, ".packages"))
      ? fs.readdirSync(path.join(root, ".packages")).sort()
      : [];
  return { root, install, packages };
}

test("installs craft-anything from a zip and checks its version", async (t) => {
  const f = await fixture(t);
  const bytes = await zipArchive();
  const messages = [];
  await f.install(zipEntry(bytes), bytes, {
    platform: "darwin",
    run: async (command, args, ...rest) =>
      command === "/usr/bin/xattr" ? "" : run(command, args, ...rest),
    progress: (message) => messages.push(message),
  });
  const managed = managedReaComponent(f.root, "craft-anything");
  assert.equal(managed.version, version);
  assert.equal(managed.home, path.join(managed.directory, zipEntry(bytes).top));
  const binary = craftBinary(managed);
  fs.accessSync(binary, fs.constants.X_OK);
  const entry = zipEntry(bytes);
  assert.equal(fs.realpathSync(craftBinaryPath(f.root, entry)), fs.realpathSync(binary));
  assert.ok(messages.includes(serverMessages.craft.downloading(100)));
  assert.equal(managedReaComponent(f.root, "rea-jdk"), null);
});

test("drops the linux GUI binary after unpacking", async (t) => {
  const f = await fixture(t);
  const bytes = tarArchive();
  await f.install(tarEntry(bytes), bytes);
  const managed = managedReaComponent(f.root, "craft-anything");
  assert.equal(managed.home, path.join(managed.directory, tarEntry(bytes).top, "bin"));
  assert.ok(!fs.existsSync(path.join(managed.home, "craft-anything")));
  fs.accessSync(path.join(managed.home, "craft-anything-cli"), fs.constants.X_OK);
});

test("a remove path that leaves the version directory is refused", async (t) => {
  const f = await fixture(t);
  const bytes = tarArchive();
  for (const remove of [["../../escape"], ["/etc/hosts"]])
    await assert.rejects(f.install(tarEntry(bytes, { remove }), bytes));
  assert.deepEqual(f.packages(), []);
});

test("refuses a binary that reports another version", async (t) => {
  const f = await fixture(t);
  const bytes = tarArchive("0.4.0");
  await assert.rejects(f.install(tarEntry(bytes), bytes), {
    message: serverMessages.craft.versionMismatch("0.5.0", "0.4.0"),
  });
  assert.equal(managedReaComponent(f.root, "craft-anything"), null);
  assert.deepEqual(f.packages(), []);
});

test("sweep removes an unpublished craft-anything version", async (t) => {
  const f = await fixture(t);
  const bytes = tarArchive();
  await f.install(tarEntry(bytes), bytes);
  const active = managedReaComponent(f.root, "craft-anything");
  const packages = path.join(f.root, ".packages");
  fs.mkdirSync(path.join(packages, "craft-anything-unpublished"));
  fs.mkdirSync(path.join(packages, "rea-jdk-published"));
  fs.writeFileSync(path.join(packages, "rea-jdk-published", "agentpier-rea.json"), "{}");
  fs.symlinkSync("x", path.join(f.root, ".craft-anything-link-1"));
  sweepReaComponents(f.root);
  assert.deepEqual(
    f.packages(),
    [path.basename(active.directory), "rea-jdk-published"].sort(),
  );
  assert.equal(fs.existsSync(path.join(f.root, ".craft-anything-link-1")), false);
  assert.deepEqual(managedReaComponent(f.root, "craft-anything"), active);
  await removeReaComponent(f.root, "craft-anything");
  assert.deepEqual(f.packages(), ["rea-jdk-published"]);
});
