import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { digest } from "../../server/features/operations/files.js";
import { Releases } from "../../server/features/operations/releases.js";
import { activateRelease } from "../../server/features/operations/release-activation.js";
const file = (name, value, mode = 0o600) => ({
  path: name,
  content: Buffer.from(value).toString("base64"),
  sha256: digest(Buffer.from(value)),
  mode,
});
test("release staging validates content and failed health restores the previous immutable release", async (t) => {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-release-")),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "install"),
    dataDir = path.join(temp, "data");
  await fs.mkdir(dataDir);
  await fs.mkdir(path.join(root, "releases/1.0.0"), { recursive: true });
  await fs.writeFile(
    path.join(root, "releases/1.0.0/release.json"),
    JSON.stringify({
      version: "1.0.0",
      schemaVersion: 1,
      schemaMin: 1,
      schemaMax: 1,
      platform: `${process.platform}-${process.arch}`,
    }),
  );
  await fs.symlink("releases/1.0.0", path.join(root, "current"));
  const manifest = {
    version: "1.1.0",
    schemaVersion: 1,
    schemaMin: 1,
    schemaMax: 1,
    platform: `${process.platform}-${process.arch}`,
  };
  const archive = gzipSync(
    JSON.stringify({
      format: "agentpier-release",
      version: 1,
      manifest,
      files: [
        file("release.json", JSON.stringify(manifest)),
        file("bin/node", "fixture", 0o755),
        file("server/index.js", "fixture"),
        file("package.json", '{"type":"module"}'),
        file("dist/index.html", "fixture"),
        file("node_modules/node-pty/package.json", "{}"),
      ],
    }),
  );
  const channel = {
    version: "1.1.0",
    artifacts: {
      [manifest.platform]: { file: "release.aprelease", sha256: digest(archive) },
    },
    schemaVersion: 1,
  };
  const fetchImpl = async (url) =>
    new Response(url.endsWith("latest.json") ? JSON.stringify(channel) : archive);
  const releases = new Releases({
    dataDir,
    installRoot: root,
    channel: "https://releases.example.invalid/",
    fetchImpl,
    smoke: async () => {},
  });
  const staged = await releases.stage({ version: "1.1.0" });
  assert.equal(await fs.readlink(path.join(root, "current")), "releases/1.0.0");
  let restarts = 0;
  await assert.rejects(
    activateRelease(
      { installRoot: root, dataDir, stagedId: staged.stagedId },
      {
        restart: async () => restarts++,
        health: async ({ version }) => version === "1.0.0",
      },
    ),
    /health/i,
  );
  assert.equal(restarts, 2);
  assert.equal(await fs.readlink(path.join(root, "current")), "releases/1.0.0");
  assert.ok(await fs.stat(path.join(root, "releases/1.1.0/server/index.js")));
  const result = await activateRelease(
    { installRoot: root, dataDir, stagedId: staged.stagedId },
    { restart: async () => {}, health: async () => true },
  );
  assert.equal(result.activated, true);
  assert.equal(await fs.readlink(path.join(root, "current")), "releases/1.1.0");
  assert.equal(
    releases.status().releases.find((r) => r.version === "1.0.0").canRollback,
    true,
  );
  await fs.mkdir(path.join(dataDir, "memory"));
  const newer = new DatabaseSync(path.join(dataDir, "memory/memory.sqlite"));
  newer.exec("PRAGMA user_version=2");
  newer.close();
  assert.equal(
    releases.status().releases.find((r) => r.version === "1.0.0").canRollback,
    false,
  );
  await assert.rejects(
    activateRelease(
      { installRoot: root, dataDir, version: "1.0.0" },
      {
        restart: async () => assert.fail("Must not restart incompatible release"),
        health: async () => true,
      },
    ),
    /schema/,
  );
  assert.equal(await fs.readlink(path.join(root, "current")), "releases/1.1.0");
});

test("detached release helper retains only native user-service environment", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-release-env-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const environment = {
    PATH: "/usr/bin",
    HOME: "/home/fixture",
    USER: "fixture",
    XDG_RUNTIME_DIR: "/run/user/1000",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_CONFIG_HOME: "/home/fixture/.config",
    OPENROUTER_API_KEY: "must-not-inherit",
  };
  let options;
  const releases = new Releases({
    dataDir: temporary,
    installRoot: path.join(temporary, "install"),
    environment,
    spawnImpl: (_command, _args, supplied) => {
      options = supplied;
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  await releases.launchActivation({ version: "1.0.0" }, "fixture-job");
  const { OPENROUTER_API_KEY: _secret, ...expected } = environment;
  assert.deepEqual(options.env, expected);
  assert.equal(options.detached, true);
});
