import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AssistantModelAccounts } from "../../server/features/assistants/model-accounts.js";
import { ChatGptVault } from "../../server/features/model-logins/chatgpt-vault.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { readBackupKey } from "../../server/features/assistants/backup-credentials.js";
import {
  createUpdateSnapshot,
  restoreUpdateSnapshot,
} from "../../server/features/assistants/runtime-update-snapshot.js";
import { scrubBackupProfile } from "../../server/features/assistants/runtime-update-scrub.js";
import { openClawStore } from "../helpers/openclaw-store.js";

// A move or a logout keeps every update snapshot restorable, and none of them can
// bring back a second refresher (runtime-update-scrub.js).
const profileId = "openai:owner@example.invalid";
const legacy = {
  type: "oauth",
  provider: "openai",
  access: "access-old",
  refresh: "refresh-old",
  expires: Date.now() + 3600_000,
  email: "owner@example.invalid",
};
const other = { type: "api_key", provider: "anthropic", key: "anthropic-key" };

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-move-backups-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  const { read } = openClawStore(t, {
    at: paths.state,
    store: { version: 1, profiles: { [profileId]: legacy, "anthropic:x": other } },
  });
  const snapshot = async () => {
    const id = randomUUID();
    const directory = path.join(paths.root, "backups", id);
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    await createUpdateSnapshot(paths, directory, { version: "fixture" });
    return { id, directory };
  };
  const runtime = {
    paths,
    client: {
      ready: false,
      call: async () => ({}),
    },
  };
  const vault = new ChatGptVault({
    dataDir,
    schedule: false,
    auth: { refresh: async () => assert.fail("no refresh") },
  });
  const accounts = new AssistantModelAccounts({
    dataDir,
    runtime,
    vault,
    warn: () => {},
  });
  // The account as the last read of a stopped Gateway left it (model-accounts.json).
  const id = `openclaw:${createHash("sha256").update(profileId).digest("hex")}`;
  accounts.records = [
    { id, profileId, name: "ChatGPT", status: "ok", holder: "openclaw" },
  ];
  t.after(() => {
    accounts.close();
    vault.close();
  });
  return { dataDir, paths, read, snapshot, accounts, vault };
}

test("a pre-move snapshot restores without OpenClaw's refresh token and keeps its key", async (t) => {
  const { paths, read, snapshot, accounts, vault } = await fixture(t);
  const before = await snapshot();
  await accounts.move(accounts.records[0].id);
  assert.equal(read().profiles[profileId].refresh, undefined);
  assert.equal(vault.records.get(profileId).refresh, "refresh-old");
  // The key stays: the next runtime update can still roll back.
  assert.ok(readBackupKey(paths.root, before.id));
  const restored = await restoreUpdateSnapshot(paths, before.directory);
  assert.equal(restored.credentialsWithheld, false);
  const store = read();
  assert.equal(store.profiles[profileId].refresh, undefined, "no second refresher");
  assert.equal(store.profiles[profileId].access, "access-old");
  assert.deepEqual(store.profiles["anthropic:x"], other, "other credentials restored");
});

test("a logout removes the profile from every snapshot; other credentials stay", async (t) => {
  const { paths, read, snapshot } = await fixture(t);
  const before = await snapshot();
  const result = await scrubBackupProfile(paths.root, profileId, { remove: true });
  assert.deepEqual(result, { scrubbed: [before.id], withheld: [] });
  await restoreUpdateSnapshot(paths, before.directory);
  assert.equal(read().profiles[profileId], undefined);
  assert.deepEqual(read().profiles["anthropic:x"], other);
  // A second pass has nothing left to change.
  assert.deepEqual(await scrubBackupProfile(paths.root, profileId, { remove: true }), {
    scrubbed: [],
    withheld: [],
  });
});

test("a part that cannot be rewritten is kept but restores without its credentials", async (t) => {
  const { paths, read, snapshot } = await fixture(t);
  const before = await snapshot();
  // A store shape AgentPier does not know, sealed in the snapshot.
  const manifestFile = path.join(before.directory, "snapshot.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.ok(manifest.sealed.includes("state/state/openclaw.sqlite"), manifest.sealed);
  const { seal, unseal, sealedSuffix } =
    await import("../../server/features/assistants/backup-credentials.js");
  const sidecar = path.join(
    before.directory,
    "payload",
    "state/state/openclaw.sqlite" + sealedSuffix,
  );
  const key = readBackupKey(paths.root, before.id);
  const aad = `${before.id}\0state/state/openclaw.sqlite`;
  const dump = JSON.parse(unseal(key, aad, fs.readFileSync(sidecar)).toString());
  for (const row of dump.config_machine_state)
    if (row.state_key === "authProfiles.store") row.value_json = "[]";
  fs.writeFileSync(sidecar, seal(key, aad, Buffer.from(JSON.stringify(dump))));
  const { digestTree } =
    await import("../../server/features/assistants/runtime-update-snapshot.js");
  manifest.digest = await digestTree(path.join(before.directory, "payload"), new Set());
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const result = await scrubBackupProfile(paths.root, profileId);
  assert.deepEqual(result.withheld, [`${before.id}/state/state/openclaw.sqlite`]);
  const restored = await restoreUpdateSnapshot(paths, before.directory);
  assert.equal(restored.credentialsWithheld, true);
  assert.equal(read(), undefined, "no credential row came back");
});
