import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { readArchiveHeader } from "../../server/features/operations/archive-v2.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { archiveText, loadArchive } from "../helpers/backup-archive.js";

// A Hermes agent's data below assistants/hermes/ (runtimes/hermes/hermes-paths.js).
const modelKey = "fixture-hermes-model-key-31337";
const botToken = "fixture-hermes-bot-token-4242";
const login = "fixture-hermes-oauth-login-777";
const bridgeToken = "fixture-hermes-bridge-token-555";
const transcript = "fixture-hermes-transcript-1234";
const cookie = "fixture-hermes-cookie-9090";
const passphrase = "hermes backup fixture phrase";
const home = "hermes/state/ap-h1";
const agentHome = "hermes/home/ap-h1";

function fixture(t) {
  const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "hermes-host-backup-")),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const dataDir = path.join(temporary, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const root = path.join(dataDir, "assistants");
  const store = new AssistantStore({ dataDir });
  store.db
    .prepare("INSERT INTO assistants VALUES (?,?,?)")
    .run("h1", 1, JSON.stringify({ id: "h1", name: "Herm", runtime: "hermes" }));
  store.close();
  const write = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
  };
  write("settings.json", JSON.stringify({ enabled: true }));
  write(`${home}/config.yaml`, "model:\n  key_env: AUXILIARY_AGENTPIER_API_KEY\n");
  write(`${home}/SOUL.md`, "Be helpful.");
  write(
    `${home}/.env`,
    `AUXILIARY_AGENTPIER_API_KEY=${modelKey}\nTELEGRAM_BOT_TOKEN=${botToken}\n`,
  );
  write(`${home}/auth.json`, JSON.stringify({ refresh: login }));
  write(`${home}/skills/notes/SKILL.md`, "---\nname: notes\n---\n");
  write(`${home}/cron/jobs.json`, JSON.stringify({ jobs: [{ id: "j1" }] }));
  write(`${home}/cron/output/j1/run.md`, transcript);
  write(`${home}/memories/MEMORY.md`, `remember ${transcript}`);
  write(`${home}/plugins/agentpier-team/plugin.yaml`, "name: agentpier-team\n");
  write(
    `${home}/plugins/agentpier-team/bridge.json`,
    JSON.stringify({ url: "http://127.0.0.1:1", token: bridgeToken }),
  );
  const sessions = new DatabaseSync(path.join(root, home, "state.db"));
  sessions.exec("CREATE TABLE messages(body TEXT)");
  sessions.prepare("INSERT INTO messages VALUES (?)").run(transcript);
  sessions.close();
  write(`${agentHome}/agentpier-browser/user-data/Default/Cookies`, cookie);
  write(`${agentHome}/notes.txt`, `home ${transcript}`);
  write("hermes/workspaces/ap-h1/draft.md", `draft ${transcript}`);
  // Runtime-only data and this host's installation never go along.
  for (const excluded of [
    `${home}/logs/agent.log`,
    `${home}/gateway_state.json`,
    `${home}/state/gateway.heartbeat`,
    `${home}/backups/env-copy`,
    `${agentHome}/.local/state/hermes/gateway-locks/host-gateway.json`,
    "hermes/runtimes/0.22.5/venv/bin/hermes",
    "hermes/logs/ap-h1/gateway.log",
    "hermes/tmp/ap-h1/x",
    "hermes/uv-cache/a",
    "hermes/runtime.json",
    "hermes/candidate.json",
  ])
    write(excluded, `excluded ${botToken}`);
  return { temporary, dataDir, root };
}
const names = (file) => loadArchive(file).files.map((member) => member.path);

test("host backups keep a Hermes agent's secrets and transcripts out of the plain part", async (t) => {
  const { temporary, dataDir } = fixture(t);
  const backup = await new Backup({ dataDir }).create();
  const paths = names(backup.file);
  for (const expected of [
    `${home}/config.yaml`,
    `${home}/SOUL.md`,
    `${home}/skills/notes/SKILL.md`,
    `${home}/cron/jobs.json`,
    `${home}/plugins/agentpier-team/plugin.yaml`,
  ])
    assert.ok(paths.includes(`assistants/${expected}`), expected);
  for (const secret of [modelKey, botToken, login, bridgeToken, transcript, cookie])
    assert.equal(archiveText(backup.file).includes(secret), false, secret);
  assert.equal(
    paths.some((name) =>
      /^assistants\/hermes\/(runtimes|logs|tmp|uv-cache)\//.test(name),
    ),
    false,
  );
  assert.equal(
    paths.some((name) => name.endsWith(".agentpier-sealed")),
    false,
  );
  const target = path.join(temporary, "restored");
  const report = await new Restore({ dataDir }).apply({
    archive: backup.file,
    targetDataDir: target,
  });
  const restored = path.join(target, "assistants");
  assert.equal(
    fs.readFileSync(path.join(restored, home, "SOUL.md"), "utf8"),
    "Be helpful.",
  );
  assert.equal(fs.existsSync(path.join(restored, home, ".env")), false);
  assert.equal(fs.existsSync(path.join(restored, home, "state.db")), false);
  assert.ok(report.credentialsNeedingLogin.includes("assistants"));
});

test("credentialed backups with history seal and restore a Hermes agent", async (t) => {
  const { temporary, dataDir } = fixture(t);
  const made = await new Backup({ dataDir }).create({
    withCredentials: true,
    includeHistory: true,
    passphrase,
  });
  for (const secret of [modelKey, botToken, login, bridgeToken, transcript, cookie])
    assert.equal(archiveText(made.file).includes(secret), false, secret);
  const header = await readArchiveHeader(made.file);
  const listed = header.members.map((member) => member.path);
  for (const name of [`${home}/.env`, `${home}/auth.json`, `${home}/state.db`])
    assert.equal(listed.includes(`assistants/${name}`), false, name);
  const target = path.join(temporary, "restored");
  const report = await new Restore({ dataDir }).apply({
    archive: made.file,
    targetDataDir: target,
    passphrase,
  });
  assert.equal(report.credentialsNeedingLogin.includes("assistants"), false);
  const restored = path.join(target, "assistants");
  const read = (relative) => fs.readFileSync(path.join(restored, relative), "utf8");
  assert.match(read(`${home}/.env`), new RegExp(modelKey));
  assert.match(read(`${home}/auth.json`), new RegExp(login));
  assert.equal(read(`${home}/memories/MEMORY.md`), `remember ${transcript}`);
  assert.equal(read(`${home}/cron/output/j1/run.md`), transcript);
  assert.equal(read(`${agentHome}/notes.txt`), `home ${transcript}`);
  assert.equal(read("hermes/workspaces/ap-h1/draft.md"), `draft ${transcript}`);
  assert.equal(read(`${agentHome}/agentpier-browser/user-data/Default/Cookies`), cookie);
  const db = new DatabaseSync(path.join(restored, home, "state.db"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT body FROM messages").get().body, transcript);
  } finally {
    db.close();
  }
  // The bridge's per-start token and the runtime-only files stay on this host.
  for (const relative of [
    `${home}/plugins/agentpier-team/bridge.json`,
    `${home}/logs/agent.log`,
    `${home}/backups/env-copy`,
    "hermes/runtimes",
    "hermes/runtime.json",
  ])
    assert.equal(fs.existsSync(path.join(restored, relative)), false, relative);
});
