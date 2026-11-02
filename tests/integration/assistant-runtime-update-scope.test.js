import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { hermesPaths } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import {
  hermesUpdateScope,
  openClawUpdateScope,
} from "../../server/features/assistants/runtime-update-scope.js";
import { destroyBackupKeys } from "../../server/features/assistants/backup-credentials.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

// OpenClaw and Hermes agents share AgentPier's agent workspace root
// (<data>/assistants/workspaces/<id>). A failed update of one runtime rolls back its
// own agents' folders only; the other runtime's agents keep what they wrote meanwhile.
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

// An update journal of `paths` whose migration writes `during` and fails.
async function failedUpdate(t, { dataDir, paths, scope, during }) {
  const selection = path.join(paths.root, "runtime.json");
  const previous = { version: "1.0.0", nodeVersion: "26.12.1" };
  writePrivate(selection, previous);
  const runtime = {
    running: true,
    status() {
      return { availability: this.running ? "ready" : "disabled" };
    },
    async stop() {
      this.running = false;
    },
    async start() {
      this.running = true;
    },
  };
  const updates = new RuntimeUpdates({
    dataDir,
    paths,
    scope,
    runtime,
    maintenance: {
      enter: async () => {},
      blockers: async () => [],
      quiesce: async () => {},
      validate: async () => {},
      leave: async () => {},
    },
    stage: async () => ({ version: "2.0.0", nodeVersion: "26.12.1" }),
    freeSpace: async () => Number.MAX_SAFE_INTEGER,
    migrate: async () => {
      during();
      throw Object.assign(Error("UPDATE_MIGRATION_FAILED"), {
        code: "UPDATE_MIGRATION_FAILED",
        status: 500,
      });
    },
  });
  t.after(() => destroyBackupKeys?.(paths.root));
  await updates.stage();
  await assert.rejects(updates.activate(), { code: "UPDATE_MIGRATION_FAILED" });
  assert.equal(updates.status().phase, "rolled_back");
  assert.deepEqual(readJSON(selection), previous);
}

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-scope-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const openclaw = runtimePaths(dataDir);
  const hermes = hermesPaths(dataDir);
  const work = (id, name) => path.join(openclaw.workspaces, id, name);
  write(work("claw", "notes.md"), "claw before");
  write(work("herm", "notes.md"), "herm before");
  return { dataDir, openclaw, hermes, work };
}

test("an OpenClaw rollback never reverts or removes a Hermes agent's workspace", async (t) => {
  const { dataDir, openclaw, work } = setup(t);
  await failedUpdate(t, {
    dataDir,
    paths: openclaw,
    scope: () => openClawUpdateScope(store),
    during: () => {
      write(work("claw", "notes.md"), "claw half migrated");
      write(work("herm", "notes.md"), "herm newer");
      write(work("herm", "new.md"), "herm new file");
    },
  });
  assert.equal(read(work("claw", "notes.md")), "claw before");
  assert.equal(read(work("herm", "notes.md")), "herm newer");
  assert.equal(read(work("herm", "new.md")), "herm new file");
});

test("a Hermes rollback restores its agents' workspaces and leaves OpenClaw's", async (t) => {
  const { dataDir, hermes, work } = setup(t);
  await failedUpdate(t, {
    dataDir,
    paths: hermes,
    scope: () => hermesUpdateScope(store),
    during: () => {
      write(work("herm", "notes.md"), "herm half migrated");
      write(work("herm", "stray.md"), "left by the failed update");
      write(work("claw", "notes.md"), "claw newer");
    },
  });
  assert.equal(read(work("herm", "notes.md")), "herm before");
  assert.equal(read(work("herm", "stray.md")), null);
  assert.equal(read(work("claw", "notes.md")), "claw newer");
});
