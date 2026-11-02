import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { hermesPaths } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import {
  hermesUpdateScope,
  openClawUpdateScope,
} from "../../server/features/assistants/runtime-update-scope.js";
import {
  createUpdateSnapshot,
  restoreUpdateSnapshot,
} from "../../server/features/assistants/runtime-update-snapshot.js";
import { scrubBackupProfile } from "../../server/features/assistants/runtime-update-scrub.js";
import { destroyBackupKeys } from "../../server/features/assistants/backup-credentials.js";
import { openClawStore } from "../helpers/openclaw-store.js";

// An OpenClaw update snapshot is both scoped to OpenClaw's agents' folders of the
// shared workspace root (runtime-update-scope.js) and scrubbed of a ChatGPT login's
// refresh token once AgentPier holds the login (runtime-update-scrub.js); a restore
// honours both, and Hermes's own snapshots keep their sealed keys.
const profileId = "openai:owner@example.invalid";
const login = {
  type: "oauth",
  provider: "openai",
  access: "access-old",
  refresh: "refresh-old",
  expires: Date.now() + 3600_000,
};
const other = { type: "api_key", provider: "anthropic", key: "anthropic-key" };
const store = {
  listAssistants: () => [
    { id: "claw", runtime: "openclaw", runtimeAgentId: "ap-claw" },
    { id: "herm", runtime: "hermes", runtimeAgentId: "ap-herm" },
  ],
};
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

async function snapshotOf(paths, scope) {
  const directory = path.join(paths.root, "backups", randomUUID());
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  const manifest = await createUpdateSnapshot(
    paths,
    directory,
    { version: "fixture" },
    { scope },
  );
  return { directory, manifest };
}

test("an OpenClaw snapshot stays runtime-scoped after a login move scrubs it", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-scope-scrub-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const openclaw = runtimePaths(dataDir);
  const hermes = hermesPaths(dataDir);
  t.after(() => destroyBackupKeys?.(openclaw.root));
  t.after(() => destroyBackupKeys?.(hermes.root));
  const { read: profiles } = openClawStore(t, {
    at: openclaw.state,
    store: { version: 1, profiles: { [profileId]: login, "anthropic:x": other } },
  });
  const work = (id, name) => path.join(openclaw.workspaces, id, name);
  write(work("claw", "notes.md"), "claw before");
  write(work("herm", "notes.md"), "herm before");
  const home = path.join(hermes.state, "ap-herm");
  const secret = "sk-hermes-secret-0123456789";
  write(path.join(home, ".env"), `AUXILIARY_AGENTPIER_API_KEY=${secret}\n`);

  const claw = await snapshotOf(openclaw, openClawUpdateScope(store));
  const herm = await snapshotOf(hermes, hermesUpdateScope(store));
  const saved = (snapshot, id) =>
    fs.existsSync(path.join(snapshot.directory, "payload", "workspaces", id));
  assert.equal(saved(claw, "herm"), false, "OpenClaw's snapshot leaves Hermes's folder");
  assert.equal(saved(claw, "claw"), true);
  const hermManifest = read(path.join(herm.directory, "snapshot.json"));

  // The login moves to AgentPier: every OpenClaw snapshot loses its refresh token.
  const result = await scrubBackupProfile(openclaw.root, profileId);
  assert.deepEqual(result, { scrubbed: [path.basename(claw.directory)], withheld: [] });
  // Hermes's snapshots never held the login and keep their sealed keys untouched.
  assert.equal(read(path.join(herm.directory, "snapshot.json")), hermManifest);

  // Both runtimes' agents write after the snapshot; OpenClaw's update then fails.
  write(work("claw", "notes.md"), "claw half migrated");
  write(work("herm", "notes.md"), "herm newer");
  const restored = await restoreUpdateSnapshot(openclaw, claw.directory, [], {
    scope: openClawUpdateScope(store),
  });
  assert.equal(restored.credentialsWithheld, false);
  assert.equal(profiles().profiles[profileId].refresh, undefined, "no second refresher");
  assert.equal(profiles().profiles[profileId].access, "access-old");
  assert.deepEqual(profiles().profiles["anthropic:x"], other);
  assert.equal(read(work("claw", "notes.md")), "claw before");
  assert.equal(read(work("herm", "notes.md")), "herm newer", "Hermes's folder kept");

  // A Hermes rollback still brings back its agent's key and leaves OpenClaw's folder.
  write(path.join(home, ".env"), "AUXILIARY_AGENTPIER_API_KEY=changed\n");
  const back = await restoreUpdateSnapshot(hermes, herm.directory, [], {
    scope: hermesUpdateScope(store),
  });
  assert.equal(back.credentialsWithheld, false);
  assert.equal(read(path.join(home, ".env")), `AUXILIARY_AGENTPIER_API_KEY=${secret}\n`);
  assert.equal(read(work("herm", "notes.md")), "herm before");
  assert.equal(read(work("claw", "notes.md")), "claw before");
});
