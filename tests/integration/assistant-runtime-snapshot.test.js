import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import {
  createUpdateSnapshot,
  restoreUpdateSnapshot,
  verifyUpdateSnapshot,
} from "../../server/features/assistants/runtime-update-snapshot.js";
import { destroyBackupKeys } from "../../server/features/assistants/backup-credentials.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-snapshot-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  const backup = path.join(paths.root, "backups", "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e01");
  fs.mkdirSync(path.dirname(backup), { mode: 0o700 });
  return { dataDir, paths, backup, payload: path.join(backup, "payload") };
}
const metadata = { previous: { version: "old" }, candidate: { version: "new" } };

test("snapshot copies real workspace links without following them", async (t) => {
  const { paths, backup, payload } = fixture(t);
  const project = path.join(paths.workspaces, "project");
  fs.mkdirSync(path.join(project, "node_modules", "pkg", "bin"), { recursive: true });
  fs.mkdirSync(path.join(project, "node_modules", ".bin"));
  fs.writeFileSync(path.join(project, "node_modules", "pkg", "bin", "cli.js"), "cli", {
    mode: 0o700,
  });
  fs.symlinkSync("../pkg/bin/cli.js", path.join(project, "node_modules", ".bin", "cli"));
  fs.writeFileSync(path.join(project, "README.md"), "readme");
  fs.linkSync(path.join(project, "README.md"), path.join(project, "hard.md"));
  fs.symlinkSync("project/README.md", path.join(paths.workspaces, "readme-link"));
  fs.symlinkSync("/etc/hosts", path.join(paths.workspaces, "absolute"));
  fs.symlinkSync("../../outside", path.join(paths.workspaces, "escaping"));
  execFileSync("mkfifo", [path.join(paths.workspaces, "pipe")]);

  const manifest = await createUpdateSnapshot(paths, backup, metadata);
  const copied = (...parts) => path.join(payload, "workspaces", ...parts);
  assert.equal(
    fs.lstatSync(copied("project/node_modules/.bin/cli")).isSymbolicLink(),
    true,
  );
  assert.equal(
    fs.readlinkSync(copied("project/node_modules/.bin/cli")),
    "../pkg/bin/cli.js",
  );
  assert.equal(fs.readlinkSync(copied("absolute")), "/etc/hosts");
  assert.equal(fs.readlinkSync(copied("escaping")), "../../outside");
  assert.equal(fs.readFileSync(copied("project/hard.md"), "utf8"), "readme");
  assert.equal(
    fs.statSync(copied("project/node_modules/pkg/bin/cli.js")).mode & 0o777,
    0o700,
  );
  assert.equal(fs.existsSync(copied("pipe")), false);
  assert.deepEqual(manifest.excludedLinks, [
    "workspaces/absolute",
    "workspaces/escaping",
  ]);
  assert.deepEqual(manifest.skipped, ["workspaces/pipe"]);

  // Excluded links do not participate in the digest; internal ones do.
  fs.unlinkSync(copied("absolute"));
  fs.symlinkSync("/elsewhere", copied("absolute"));
  await verifyUpdateSnapshot(paths, backup);
  fs.unlinkSync(copied("readme-link"));
  fs.symlinkSync("project/hard.md", copied("readme-link"));
  await assert.rejects(verifyUpdateSnapshot(paths, backup), /restore boundary/);
  fs.unlinkSync(copied("readme-link"));
  fs.symlinkSync("project/README.md", copied("readme-link"));

  fs.rmSync(paths.workspaces, { recursive: true });
  await restoreUpdateSnapshot(paths, backup);
  assert.equal(
    fs.readlinkSync(path.join(paths.workspaces, "project/node_modules/.bin/cli")),
    "../pkg/bin/cli.js",
  );
  assert.equal(
    fs.readFileSync(path.join(paths.workspaces, "readme-link"), "utf8"),
    "readme",
  );
});

test(
  "a snapshot that still fails names the offending relative path",
  {
    skip: process.getuid?.() === 0,
  },
  async (t) => {
    const { paths, backup } = fixture(t);
    fs.mkdirSync(path.join(paths.state, "locked"));
    fs.writeFileSync(path.join(paths.state, "locked", "secret"), "x", { mode: 0 });
    await assert.rejects(createUpdateSnapshot(paths, backup, metadata), (error) => {
      assert.equal(error.code, "SNAPSHOT_FAILED");
      assert.equal(error.path, "state/locked/secret");
      assert.match(error.message, /state\/locked\/secret/);
      return true;
    });
  },
);

test("snapshotting thousands of files keeps the event loop responsive", async (t) => {
  const { paths, backup } = fixture(t);
  for (let d = 0; d < 20; d++) {
    const directory = path.join(paths.workspaces, `d${d}`);
    fs.mkdirSync(directory);
    for (let f = 0; f < 100; f++)
      fs.writeFileSync(path.join(directory, `f${f}.txt`), `file ${d}/${f}\n`.repeat(64));
  }
  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let done = false;
  const latencies = [];
  const probe = (async () => {
    while (!done) {
      const started = performance.now();
      await new Promise((resolve, reject) =>
        http
          .get({ host: "127.0.0.1", port, path: "/" }, (res) =>
            res.resume().on("end", resolve),
          )
          .on("error", reject),
      );
      latencies.push(performance.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  await createUpdateSnapshot(paths, backup, metadata);
  done = true;
  await probe;
  histogram.disable();
  assert.ok(latencies.length >= 2, "requests were answered during the snapshot");
  assert.ok(Math.max(...latencies) < 200, `slowest request ${Math.max(...latencies)} ms`);
  assert.ok(histogram.percentile(99) / 1e6 < 100, "event-loop p99 below 100 ms");
});

function seedCredentials(paths) {
  const agent = path.join(paths.state, "agents", "main", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "auth-profiles.json"), '{"token":"oauth-SECRET-1"}');
  fs.mkdirSync(path.join(paths.state, "state"));
  const state = new DatabaseSync(path.join(paths.state, "state", "openclaw.sqlite"));
  state.exec(`CREATE TABLE auth_profile_store(profile_id TEXT PRIMARY KEY, value_json TEXT);
    INSERT INTO auth_profile_store VALUES ('openai:me', '{"refresh":"refresh-SECRET-2"}');
    CREATE TABLE conversations(id TEXT PRIMARY KEY, body TEXT);
    INSERT INTO conversations VALUES ('c1', 'history survives');`);
  state.close();
  fs.writeFileSync(
    paths.config,
    JSON.stringify({
      gateway: { auth: { mode: "token", token: "gateway-SECRET-3" } },
      models: {
        providers: {
          "ap-x": { apiKey: "provider-SECRET-4", models: [{ id: "m", maxTokens: 5 }] },
        },
      },
    }),
  );
  const channels = new DatabaseSync(path.join(paths.root, "channels.sqlite"));
  channels.exec(`CREATE TABLE channels(id TEXT PRIMARY KEY);
    CREATE TABLE channel_credentials(id TEXT PRIMARY KEY REFERENCES channels(id), token TEXT NOT NULL);
    INSERT INTO channels VALUES ('ch'); INSERT INTO channel_credentials VALUES ('ch', 'bot-SECRET-5');`);
  channels.close();
}
function backupBytes(directory) {
  let text = "";
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true }))
    if (entry.isFile())
      text += fs.readFileSync(path.join(entry.parentPath, entry.name)).toString("latin1");
  return text;
}

test("backups seal credentials and withhold them once their key is destroyed", async (t) => {
  const { paths, backup } = fixture(t);
  seedCredentials(paths);
  const manifest = await createUpdateSnapshot(paths, backup, metadata);
  assert.doesNotMatch(backupBytes(backup), /SECRET/);
  assert.deepEqual(manifest.sealed, [
    "ledgers/channels.sqlite",
    "state/agents/main/agent/auth-profiles.json",
    "state/openclaw.json",
    "state/state/openclaw.sqlite",
  ]);
  const key = path.join(paths.root, "backup-keys", `${path.basename(backup)}.key`);
  assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(key)).mode & 0o777, 0o700);

  fs.rmSync(paths.state, { recursive: true });
  fs.mkdirSync(paths.state);
  const restored = await restoreUpdateSnapshot(paths, backup);
  assert.equal(restored.credentialsWithheld, false);
  const auth = path.join(paths.state, "agents/main/agent/auth-profiles.json");
  assert.match(fs.readFileSync(auth, "utf8"), /oauth-SECRET-1/);
  let state = new DatabaseSync(path.join(paths.state, "state", "openclaw.sqlite"));
  assert.equal(state.prepare("SELECT count(*) AS n FROM auth_profile_store").get().n, 1);
  state.close();
  assert.equal(
    JSON.parse(fs.readFileSync(paths.config)).gateway.auth.token,
    "gateway-SECRET-3",
  );

  destroyBackupKeys(paths.root);
  assert.equal(fs.existsSync(key), false);
  const withheld = await restoreUpdateSnapshot(paths, backup);
  assert.equal(withheld.credentialsWithheld, true);
  assert.equal(fs.existsSync(auth), false);
  state = new DatabaseSync(path.join(paths.state, "state", "openclaw.sqlite"));
  assert.equal(state.prepare("SELECT count(*) AS n FROM auth_profile_store").get().n, 0);
  assert.equal(
    state.prepare("SELECT body FROM conversations").get().body,
    "history survives",
  );
  state.close();
  const config = JSON.parse(fs.readFileSync(paths.config));
  assert.equal(config.gateway.auth.token, undefined);
  assert.equal(config.gateway.auth.mode, "token");
  assert.equal(config.models.providers["ap-x"].apiKey, undefined);
  assert.equal(config.models.providers["ap-x"].models[0].maxTokens, 5);
});

test("files named like databases that are not Gateway SQLite stores keep their bytes", async (t) => {
  const { paths, backup, payload } = fixture(t);
  const corrupt = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(80, 7)]);
  const files = {
    "workspaces/notes.db": Buffer.from("plain text, not a database"),
    "workspaces/corrupt.sqlite": corrupt,
    "workspaces/corrupt.sqlite-wal": Buffer.from("journal bytes"),
    "state/Thumbs.db": Buffer.from("thumbnail cache"),
  };
  for (const [relative, bytes] of Object.entries(files))
    fs.writeFileSync(path.join(paths.root, relative), bytes);
  const manifest = await createUpdateSnapshot(paths, backup, metadata);
  assert.deepEqual(manifest.sealed, []);
  for (const [relative, bytes] of Object.entries(files))
    assert.deepEqual(fs.readFileSync(path.join(payload, relative)), bytes);
  for (const relative of Object.keys(files))
    fs.writeFileSync(path.join(paths.root, relative), "changed");
  await restoreUpdateSnapshot(paths, backup);
  for (const [relative, bytes] of Object.entries(files))
    assert.deepEqual(fs.readFileSync(path.join(paths.root, relative)), bytes);
});

test("revocation removes legacy plaintext update backups and keeps sealed ones", async (t) => {
  const { paths, backup } = fixture(t);
  seedCredentials(paths);
  await createUpdateSnapshot(paths, backup, metadata);
  const legacy = (id) => {
    const directory = path.join(paths.root, "backups", id);
    const auth = path.join(
      directory,
      "payload/state/agents/main/agent/auth-profiles.json",
    );
    fs.mkdirSync(path.dirname(auth), { recursive: true, mode: 0o700 });
    fs.writeFileSync(auth, "oauth-SECRET-legacy", { mode: 0o600 });
    fs.writeFileSync(
      path.join(directory, "snapshot.json"),
      JSON.stringify({ format: 1 }),
    );
    return directory;
  };
  const first = legacy("8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e0a");
  destroyBackupKeys(paths.root);
  assert.equal(fs.existsSync(first), false);
  assert.ok(fs.existsSync(path.join(backup, "snapshot.json")));
  // Installs that only ever made legacy backups have no key folder at all.
  fs.rmSync(path.join(paths.root, "backup-keys"), { recursive: true, force: true });
  const second = legacy("8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e0b");
  destroyBackupKeys(paths.root);
  assert.equal(fs.existsSync(second), false);
  assert.ok(fs.existsSync(path.join(backup, "snapshot.json")));
});
