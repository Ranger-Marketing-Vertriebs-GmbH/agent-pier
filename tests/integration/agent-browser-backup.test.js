import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { loadArchive } from "../helpers/backup-archive.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import {
  browserCachesOmission,
  browserProfilesComponent,
  browserProfilesOmission,
} from "../../server/features/operations/browser-profile-backup.js";

const passphrase = "browser backup fixture phrase";
const cookie = "fixture-session-cookie-4711";
const cached = "fixture-cached-page-0815";
const profile = "state/browser/agent-a1/user-data";

function fixture(t) {
  const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-backup-")),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const dataDir = path.join(temporary, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const root = path.join(dataDir, "assistants");
  const store = new AssistantStore({ dataDir });
  store.db
    .prepare("INSERT INTO assistants VALUES (?,?,?)")
    .run("a1", 1, JSON.stringify({ id: "a1", name: "Shopper" }));
  store.close();
  const write = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
  };
  fs.mkdirSync(path.join(root, profile, "Default"), { recursive: true });
  const cookies = new DatabaseSync(path.join(root, profile, "Default/Cookies"));
  cookies.exec("CREATE TABLE cookies(host TEXT, value TEXT)");
  cookies.prepare("INSERT INTO cookies VALUES (?,?)").run("shop.example", cookie);
  cookies.close();
  write(`${profile}/Local State`, JSON.stringify({ profile: {} }));
  write(`${profile}/Default/Preferences`, "{}");
  for (const cache of [
    "Default/Cache/Cache_Data/f_0001",
    "Default/Code Cache/js/1",
    "GPUCache/data_0",
  ])
    write(`${profile}/${cache}`, cached);
  // Slots of temporary members and OpenClaw's default profile never go along.
  write("state/browser/member-1/user-data/Default/Preferences", "member");
  write("state/browser/openclaw/user-data/Default/Preferences", "default");
  fs.symlinkSync("host-1234", path.join(root, profile, "SingletonLock"));
  return { dataDir, root };
}
const archive = (file) => loadArchive(file);
const text = (file) =>
  archive(file)
    .files.map((m) => Buffer.from(m.content || "", "base64").toString("latin1"))
    .join("\n");
const paths = (file) => archive(file).files.map((m) => m.path);

test("without a passphrase agent browser profiles are left out entirely", async (t) => {
  const { dataDir } = fixture(t);
  const backup = new Backup({ dataDir });
  const plan = backup.plan({});
  assert.ok(plan.omissions.includes(browserProfilesOmission));
  assert.ok(plan.omissions.includes(browserCachesOmission));
  assert.equal(plan.components.includes(browserProfilesComponent), false);
  const created = await backup.create();
  assert.equal(
    paths(created.file).some((name) => name.startsWith("assistants/state/browser")),
    false,
  );
  assert.equal(text(created.file).includes(cookie), false);
});

test("with a passphrase agent profiles are sealed and restore without caches", async (t) => {
  const { dataDir } = fixture(t);
  const backup = new Backup({ dataDir });
  assert.ok(
    backup.plan({ withCredentials: true }).components.includes(browserProfilesComponent),
  );
  const created = await backup.create({ withCredentials: true, passphrase });
  const names = paths(created.file);
  assert.equal(
    names.some((name) => name.startsWith("assistants/state/browser")),
    false,
  );
  const bytes = fs.readFileSync(created.file).toString("latin1");
  assert.equal(bytes.includes(cookie), false);
  assert.equal(bytes.includes(cached), false);

  const target = path.join(path.dirname(dataDir), "restored");
  await new Restore({ dataDir }).apply({
    archive: created.file,
    targetDataDir: target,
    passphrase,
  });
  const restored = path.join(target, "assistants", profile);
  const db = new DatabaseSync(path.join(restored, "Default/Cookies"), { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM cookies").get().value, cookie);
  db.close();
  assert.equal(fs.readFileSync(path.join(restored, "Default/Preferences"), "utf8"), "{}");
  for (const cache of [
    "Default/Cache",
    "Default/Code Cache",
    "GPUCache",
    "SingletonLock",
  ])
    assert.equal(fs.existsSync(path.join(restored, cache)), false, cache);
  const browser = path.join(target, "assistants/state/browser");
  assert.deepEqual(fs.readdirSync(browser), ["agent-a1"]);
});
