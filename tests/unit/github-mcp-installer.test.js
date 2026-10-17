import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  installGithubMcp,
  managedGithubMcp,
  provisionGithubMcp,
  pruneGithubMcpPackages,
  unpackGithubMcp,
} from "../../server/features/tools/github-mcp-installer.js";
import { githubMcpManifest } from "../../server/features/tools/github-mcp-manifest.js";
import { GithubMcpTool } from "../../server/features/tools/github-mcp-tool.js";

// A gzip'd ustar archive with regular files (or other entry types) at its root.
function tarball(entries) {
  const blocks = [];
  for (const { name, data = Buffer.alloc(0), type = "0" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000755\0", 100);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write(type, 156);
    header.write("ustar\0", 257);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const archive = tarball([
  { name: "LICENSE", data: Buffer.from("MIT") },
  { name: "README.md", data: Buffer.from("readme") },
  { name: "github-mcp-server", data: Buffer.from("#!binary") },
]);
const manifest = (buffer = archive, version = "9.9.9") => ({
  version,
  platforms: {
    "linux-x64": {
      url: "https://github.com/github/github-mcp-server/releases/download/v9.9.9/a.tar.gz",
      sha256: createHash("sha256").update(buffer).digest("hex"),
      size: buffer.length,
    },
  },
});
const respond = (buffer) => async () => new Response(buffer);
const runVersion =
  (version = "9.9.9") =>
  async () =>
    `GitHub MCP Server\nVersion: ${version}\nCommit: x\n`;
function root(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "github-mcp-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("every supported platform pins a release archive with its checksum", () => {
  assert.match(githubMcpManifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(githubMcpManifest.platforms).sort(), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
  ]);
  for (const entry of Object.values(githubMcpManifest.platforms)) {
    assert.match(
      entry.url,
      new RegExp(
        `^https://github\\.com/github/github-mcp-server/releases/download/v${githubMcpManifest.version.replaceAll(".", "\\.")}/`,
      ),
    );
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0);
  }
});

test("only the binary and license leave the archive, and both must be files", async () => {
  const files = await unpackGithubMcp(archive);
  assert.deepEqual([...files.keys()].sort(), ["LICENSE", "github-mcp-server"]);
  await assert.rejects(
    unpackGithubMcp(tarball([{ name: "LICENSE", data: Buffer.from("MIT") }])),
    { status: 409 },
  );
  await assert.rejects(
    unpackGithubMcp(
      tarball([
        { name: "LICENSE", data: Buffer.from("MIT") },
        { name: "github-mcp-server", type: "2" },
      ]),
    ),
    { status: 409 },
  );
  await assert.rejects(unpackGithubMcp(Buffer.from("not gzip")), { status: 409 });
});

test("an install checks the checksum and version, then activates atomically", async (t) => {
  const dir = root(t);
  const options = { root: dir, platform: "linux", arch: "x64", manifest: manifest() };
  const first = await installGithubMcp({
    ...options,
    fetchImpl: respond(archive),
    run: runVersion(),
  });
  const installed = managedGithubMcp(dir);
  assert.equal(installed.version, "9.9.9");
  assert.equal(installed.executable, first.executable);
  assert.equal(fs.readFileSync(installed.executable, "utf8"), "#!binary");
  assert.equal(fs.statSync(installed.executable).mode & 0o777, 0o700);
  // A tampered download or a binary reporting another version changes nothing.
  const tampered = Buffer.from(archive);
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(
    installGithubMcp({ ...options, fetchImpl: respond(tampered), run: runVersion() }),
    { status: 409 },
  );
  await assert.rejects(
    installGithubMcp({
      ...options,
      fetchImpl: respond(archive),
      run: runVersion("1.0.0"),
    }),
    { status: 409 },
  );
  assert.equal(managedGithubMcp(dir).executable, first.executable);
  // A redirect may only lead to GitHub's release hosts.
  await assert.rejects(
    installGithubMcp({
      ...options,
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.test/a" } }),
      run: runVersion(),
    }),
    { status: 409 },
  );
  // An update replaces the link and keeps the previous version for running servers.
  const second = await installGithubMcp({
    ...options,
    fetchImpl: respond(archive),
    run: runVersion(),
  });
  assert.notEqual(second.executable, first.executable);
  assert.equal(managedGithubMcp(dir).executable, second.executable);
  assert.ok(fs.existsSync(first.executable));
  assert.equal(
    fs.readdirSync(path.join(dir, ".packages")).filter((n) => n.startsWith("github-mcp-"))
      .length,
    2,
  );
});

test("the installer update path keeps an installed server at the pinned version", async (t) => {
  const dataDir = root(t);
  const calls = [];
  const install = async (options) => {
    calls.push(options.manifest.version);
    return { version: options.manifest.version };
  };
  // Nothing installed and not asked for: nothing happens, nothing is downloaded.
  assert.equal(await provisionGithubMcp({ dataDir }, { install }), null);
  assert.deepEqual(calls, []);
  const clis = path.join(dataDir, "clis");
  fs.mkdirSync(clis);
  await installGithubMcp({
    root: clis,
    platform: "linux",
    arch: "x64",
    manifest: manifest(),
    fetchImpl: respond(archive),
    run: runVersion(),
  });
  assert.deepEqual(
    await provisionGithubMcp(
      { dataDir, platform: "linux", arch: "x64" },
      { install, manifest: manifest() },
    ),
    { status: "ready", version: "9.9.9" },
  );
  assert.deepEqual(calls, []);
  const newer = manifest(archive, "10.0.0");
  assert.deepEqual(
    await provisionGithubMcp(
      { dataDir, platform: "linux", arch: "x64" },
      { install, manifest: newer },
    ),
    { status: "ready", version: "10.0.0" },
  );
  assert.deepEqual(calls, ["10.0.0"]);
});

test("the running service installs on first use and reports its state", async (t) => {
  const dataDir = root(t);
  let ready = 0;
  const tool = new GithubMcpTool({
    dataDir,
    platform: "linux",
    arch: "x64",
    manifest: manifest(),
    install: (options) =>
      installGithubMcp({ ...options, fetchImpl: respond(archive), run: runVersion() }),
  });
  tool.onReady = () => ready++;
  assert.deepEqual(tool.state(), {
    available: true,
    installed: false,
    version: null,
    pinnedVersion: "9.9.9",
    status: "idle",
    message: "",
  });
  assert.equal(tool.executable(), null);
  tool.keepCurrent();
  assert.equal(tool.state().status, "idle");
  fs.mkdirSync(path.join(dataDir, "clis"));
  const job = tool.ensure();
  assert.equal(tool.ensure(), job);
  assert.equal(tool.state().status, "running");
  await job;
  assert.equal(ready, 1);
  assert.equal(tool.state().status, "succeeded");
  assert.match(tool.executable(), /github-mcp-server$/);
  assert.equal(tool.ensure(), null);
  const unsupported = new GithubMcpTool({ dataDir, platform: "win32", arch: "x64" });
  assert.equal(unsupported.state().available, false);
  assert.equal(unsupported.ensure(), null);
});

test("pruning keeps whatever the activation link points to at that moment", async (t) => {
  const dir = root(t);
  const packages = path.join(dir, ".packages");
  for (const name of ["github-mcp-a", "github-mcp-b", "github-mcp-c", "chromium-x"])
    fs.mkdirSync(path.join(packages, name), { recursive: true });
  // Another install switched the link meanwhile: its target survives the prune.
  fs.symlinkSync(".packages/github-mcp-c", path.join(dir, "github-mcp-server"), "dir");
  await pruneGithubMcpPackages(dir, [path.join(packages, "github-mcp-a")]);
  assert.deepEqual(fs.readdirSync(packages).sort(), [
    "chromium-x",
    "github-mcp-a",
    "github-mcp-c",
  ]);
});
