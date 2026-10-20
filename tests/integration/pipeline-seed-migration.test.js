import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PipelineDefinitions } from "../../server/features/pipelines/pipeline-definitions.js";
import {
  previousSeedRoles,
  seedPipelines,
  seedProfiles,
} from "../../server/features/pipelines/profile-seeds.js";
import { SEED_REVISION } from "../../server/features/pipelines/seed-migration.js";

const accounts = {
  get(id) {
    if (!/^local-(claude|codex|opencode)$/.test(id))
      throw Object.assign(new Error("Missing account"), { status: 404 });
    return { id, tool: id.slice(6), kind: "local", hasSecret: true };
  },
};
const FIRST = [
  "planner",
  "implementer",
  "code-reviewer",
  "security-reviewer",
  "conflict-resolver",
  "bug-hunter",
  "app-tester",
  "app-tester-interactive",
  "default",
];
const ADDED = ["spec-writer", "ux-reviewer", "ui-reviewer", "approver"];
const current = Object.fromEntries(
  seedProfiles("now").map((p) => [p.seedKey, p.config.prompts.role]),
);

async function dataDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentpier-seeds-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const file = (dir) => path.join(dir, "pipelines", "definitions.json");
const open = (dir) => new PipelineDefinitions({ dataDir: dir, accounts });
const read = (dir) => JSON.parse(fs.readFileSync(file(dir), "utf8"));

// A definitions document as AgentPier's first releases wrote it: the first nine seed
// profiles with their original role texts, one pipeline and no seed record.
function writeLegacy(dir, change = (state) => state) {
  const at = "2026-01-01T00:00:00.000Z";
  const profiles = seedProfiles(at)
    .filter((p) => FIRST.includes(p.seedKey))
    .map((p) => {
      const role = previousSeedRoles[p.seedKey]?.[0] ?? p.config.prompts.role;
      p.description = role;
      p.config.prompts.role = role;
      return p;
    });
  const state = change({
    version: 1,
    profiles,
    pipelines: seedPipelines(at).filter((p) => p.id === "seed-implement-review"),
    verification: {},
  });
  fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
  fs.writeFileSync(file(dir), JSON.stringify(state));
}
const keys = (store) => store.listProfiles().map((p) => p.seedKey);
const profileOf = (store, key) => store.listProfiles().find((p) => p.seedKey === key);

test("a new installation gets every seed and records them", async (t) => {
  const dir = await dataDir(t);
  const store = open(dir);
  assert.deepEqual(
    keys(store),
    seedProfiles("now").map((p) => p.seedKey),
  );
  assert.deepEqual(
    store.listPipelines().map((p) => p.id),
    ["seed-implement-review", "seed-software-factory"],
  );
  const saved = read(dir);
  assert.equal(saved.seedRevision, SEED_REVISION);
  assert.ok(saved.seedsApplied.includes("profile:ux-reviewer"));
  assert.ok(saved.seedsApplied.includes("pipeline:seed-software-factory"));
  // The factory pipeline is runnable as seeded.
  const snapshot = store.snapshot("seed-software-factory");
  assert.equal(Object.keys(snapshot.profiles).length, 7);
});

test("an existing installation gets the new seeds once and keeps its own rows", async (t) => {
  const dir = await dataDir(t);
  writeLegacy(dir);
  const store = open(dir);
  for (const key of ADDED) assert.ok(keys(store).includes(key), key);
  assert.ok(store.listPipelines().some((p) => p.id === "seed-software-factory"));
  assert.equal(profileOf(store, "approver").config.run.earlierVerdicts, true);
  const first = fs.readFileSync(file(dir), "utf8");
  // A second start changes nothing and duplicates nothing.
  const again = open(dir);
  assert.equal(fs.readFileSync(file(dir), "utf8"), first);
  assert.equal(new Set(keys(again)).size, keys(again).length);
  assert.equal(again.listPipelines().length, 2);
});

test("a seed the owner deleted is not added again", async (t) => {
  const dir = await dataDir(t);
  // Deleted before seeds were tracked: a first-release seed stays deleted.
  writeLegacy(dir, (state) => ({
    ...state,
    profiles: state.profiles.filter((p) => p.seedKey !== "bug-hunter"),
    pipelines: [],
  }));
  let store = open(dir);
  assert.ok(!keys(store).includes("bug-hunter"));
  assert.ok(!store.listPipelines().some((p) => p.id === "seed-implement-review"));
  // Deleted after: the record keeps a removed new seed from coming back.
  store.removePipeline("seed-software-factory");
  store.removeProfile("seed-ux-reviewer");
  store = open(dir);
  assert.ok(!keys(store).includes("ux-reviewer"));
  assert.ok(!store.listPipelines().some((p) => p.id === "seed-software-factory"));
});

test("the factory pipeline is not seeded when one of its profiles was deleted", async (t) => {
  const dir = await dataDir(t);
  writeLegacy(dir, (state) => ({
    ...state,
    profiles: state.profiles.filter((p) => p.seedKey !== "security-reviewer"),
  }));
  const store = open(dir);
  assert.ok(!store.listPipelines().some((p) => p.id === "seed-software-factory"));
  assert.ok(read(dir).seedsApplied.includes("pipeline:seed-software-factory"));
});

test("an edited seed role stays; an unedited earlier seed text is updated", async (t) => {
  const dir = await dataDir(t);
  writeLegacy(dir, (state) => {
    const implementer = state.profiles.find((p) => p.seedKey === "implementer");
    implementer.config.prompts.role = "Our own implementer rules.";
    implementer.revision = 4;
    // Another account but the seeded role: only the role is brought up to date.
    const reviewer = state.profiles.find((p) => p.seedKey === "code-reviewer");
    reviewer.config.accountId = "local-codex";
    reviewer.config.cliTool = "codex";
    reviewer.revision = 2;
    // An intermediate text from a release candidate counts as unedited as well.
    const tester = state.profiles.find((p) => p.seedKey === "app-tester");
    tester.config.prompts.role = previousSeedRoles["app-tester"][2];
    return state;
  });
  const store = open(dir);
  const implementer = profileOf(store, "implementer");
  assert.equal(implementer.config.prompts.role, "Our own implementer rules.");
  assert.equal(implementer.revision, 4);
  const reviewer = profileOf(store, "code-reviewer");
  assert.equal(reviewer.config.prompts.role, current["code-reviewer"]);
  assert.equal(reviewer.description, current["code-reviewer"]);
  assert.equal(reviewer.config.accountId, "local-codex");
  assert.equal(reviewer.revision, 3);
  const tester = profileOf(store, "app-tester");
  assert.equal(tester.config.prompts.role, current["app-tester"]);
  // The description was not the role the tester ran with, so it stays.
  assert.equal(tester.description, previousSeedRoles["app-tester"][0]);
  assert.equal(profileOf(store, "planner").config.prompts.role, current.planner);
  // Updated once: a role set back to an earlier seed text later is left alone.
  const latest = profileOf(store, "planner");
  store.saveProfile(
    {
      ...latest,
      config: {
        ...latest.config,
        prompts: { ...latest.config.prompts, role: previousSeedRoles.planner[0] },
      },
      expectedRevision: latest.revision,
    },
    latest.id,
  );
  assert.equal(
    profileOf(open(dir), "planner").config.prompts.role,
    previousSeedRoles.planner[0],
  );
});
