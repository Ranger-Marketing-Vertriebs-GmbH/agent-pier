import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PipelineDefinitions } from "../../server/features/pipelines/pipeline-definitions.js";
import { renderProfilePrompt } from "../../server/features/pipelines/profile-validation.js";

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agentpier-definitions-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const accounts = {
    get(id) {
      if (!/^local-(claude|codex|opencode)$/.test(id))
        throw Object.assign(new Error("Missing account"), { status: 404 });
      return { id, tool: id.slice(6), kind: "local", hasSecret: true };
    },
  };
  const store = new PipelineDefinitions({ dataDir, accounts });
  return { dataDir, accounts, store };
}
function profile(tool = "codex") {
  return {
    name: "Implement",
    enabled: true,
    config: {
      accountId: `local-${tool}`,
      cliTool: tool,
      models: { available: [""], default: "" },
      prompts: {
        role: "Use the repository conventions.",
        kickoff: "Implement {{target}}",
        params: [],
      },
      permissions: { mode: tool === "codex" ? "never" : "auto" },
      run: { autonomous: true },
    },
  };
}
test("pipeline definitions freeze profiles, reject stale edits and preserve snapshots across restart", async (t) => {
  const { store, dataDir, accounts } = await fixture(t);
  const first = store.saveProfile(profile());
  const pipeline = store.savePipeline({
    name: "Build",
    graph: {
      entry: "work",
      nodes: [{ id: "work", kind: "profile", profileId: first.id }],
      edges: [],
    },
  });
  const snapshot = store.snapshot(pipeline.id);
  store.saveProfile(
    { ...profile(), name: "Renamed", expectedRevision: first.revision },
    first.id,
  );
  assert.equal(snapshot.profiles[first.id].name, "Implement");
  assert.equal(snapshot.profiles[first.id].accountSnapshot.hasSecret, undefined);
  assert.throws(
    () => store.saveProfile({ ...profile(), expectedRevision: first.revision }, first.id),
    { status: 409 },
  );
  assert.throws(() => store.removeProfile(first.id), { status: 409 });
  const reopened = new PipelineDefinitions({ dataDir, accounts });
  assert.equal(reopened.getProfile(first.id).name, "Renamed");
  const latest = reopened.getProfile(first.id);
  reopened.saveProfile(
    { ...latest, enabled: false, expectedRevision: latest.revision },
    first.id,
  );
  assert.throws(() => reopened.snapshot(pipeline.id), { status: 409 });
  assert.throws(
    () => reopened.savePipeline({ ...pipeline, name: "New invalid definition" }),
    { status: 400 },
  );
  reopened.removePipeline(pipeline.id);
  reopened.removeProfile(first.id);
  assert.throws(() => reopened.getProfile(first.id), { status: 404 });
});
test("profile parameters and native permissions validate before persistence", async (t) => {
  const { store } = await fixture(t);
  assert.throws(() => store.saveProfile({ ...profile(), name: "Invalid\nname" }), {
    status: 400,
  });
  const custom = profile();
  custom.config.prompts.params = [{ key: "target", label: "Target", required: true }];
  const saved = store.saveProfile(custom);
  assert.throws(
    () =>
      store.savePipeline({
        name: "Invalid",
        graph: {
          entry: "work",
          nodes: [{ id: "work", kind: "profile", profileId: saved.id }],
          edges: [],
        },
      }),
    /required parameters/,
  );
  assert.throws(() => renderProfilePrompt(saved, {}), /required/);
  assert.throws(
    () => renderProfilePrompt(saved, { target: "x", unknown: "x" }),
    /Unknown/,
  );
  assert.match(
    renderProfilePrompt(saved, { target: "{{target}}" }),
    /Implement \{\{target\}\}/,
  );
  for (const tool of ["codex", "claude", "opencode"]) {
    const row = profile(tool);
    row.config.permissions.mode = "unknown";
    assert.throws(() => store.saveProfile(row), /permission/);
  }
  assert.throws(
    () =>
      store.saveProfile({
        ...profile(),
        config: { ...profile().config, accountId: "local-claude" },
      }),
    /account/,
  );
});
test("verification plans are bounded, secret-free profile seeds are editable and seed deletion persists", async (t) => {
  const { store, dataDir, accounts } = await fixture(t);
  const seed = store.listProfiles().find((item) => item.seedKey);
  assert.ok(seed);
  for (const pipeline of store.listPipelines()) store.removePipeline(pipeline.id);
  store.removeProfile(seed.id);
  assert.ok(
    !new PipelineDefinitions({ dataDir, accounts })
      .listProfiles()
      .some((item) => item.id === seed.id),
  );
  const config = store.saveVerification("project-fixture", {
    steps: [{ name: "Test", command: "npm test", timeoutMs: 1000, blocking: true }],
  });
  assert.equal(config.steps[0].blocking, true);
  assert.deepEqual(store.getVerification("project-fixture"), config);
  assert.throws(
    () =>
      store.saveVerification("project-fixture", {
        steps: [{ name: "Bad", command: "x", timeoutMs: 7200001, blocking: true }],
      }),
    /timeout/i,
  );
  assert.throws(
    () =>
      store.saveVerification("project-fixture", {
        steps: [{ name: "Bad", command: "x", timeoutMs: 1000, blocking: "false" }],
      }),
    /blocking/,
  );
});
