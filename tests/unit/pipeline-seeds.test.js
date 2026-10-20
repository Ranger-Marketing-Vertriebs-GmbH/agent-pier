import test from "node:test";
import assert from "node:assert/strict";
import { validateGraph } from "../../server/features/pipelines/graph-validation.js";
import { compileSnapshot } from "../../server/features/pipelines/graph-navigation.js";
import {
  graphToStages,
  stagesToGraph,
} from "../../web/features/pipelines/graph-editor.js";
import { validateProfile } from "../../server/features/pipelines/profile-validation.js";
import {
  previousSeedRoles,
  seedPipelines,
  seedProfiles,
} from "../../server/features/pipelines/profile-seeds.js";

const now = "2026-10-20T00:00:00Z";
const profiles = seedProfiles(now);
const byId = new Map(profiles.map((p) => [p.id, p]));
const role = (key) => profiles.find((p) => p.seedKey === key).config.prompts.role;
const accounts = { get: (id) => ({ id, tool: id.slice(6), kind: "local" }) };
const factory = () => seedPipelines(now).find((p) => p.id === "seed-software-factory");

test("every seed profile passes profile validation unchanged", () => {
  for (const profile of profiles) {
    const valid = validateProfile(profile, accounts);
    assert.equal(valid.config.prompts.role, profile.config.prompts.role, profile.seedKey);
    assert.deepEqual(valid.config.run, profile.config.run, profile.seedKey);
  }
});

test("every seed pipeline graph validates and runs enabled autonomous seed profiles", () => {
  for (const pipeline of seedPipelines(now)) {
    assert.deepEqual(validateGraph(pipeline.graph), pipeline.graph, pipeline.id);
    // The stage view opens it and saves it back unchanged.
    assert.deepEqual(stagesToGraph(graphToStages(pipeline.graph)), pipeline.graph);
    const ids = pipeline.graph.nodes.flatMap((n) =>
      n.kind === "parallel" ? n.members.map((m) => m.profileId) : n.profileId || [],
    );
    for (const id of ids) {
      const profile = byId.get(id);
      assert.ok(profile, id);
      assert.equal(profile.enabled, true, id);
      assert.equal(profile.config.run.autonomous, true, id);
      assert.deepEqual(profile.config.prompts.params, [], id);
    }
  }
});

test("the software factory runs spec, implementation, verification, four reviewers, approval and a PR", () => {
  const pipeline = factory();
  assert.equal(pipeline.name, "Software factory");
  const run = compileSnapshot({
    pipeline,
    profiles: Object.fromEntries(profiles.map((p) => [p.id, p])),
  });
  const route = (from, condition = "default") =>
    run.edges.find((e) => e.from === from && e.condition === condition);
  assert.equal(run.entry, "spec");
  // The spec gate is off by default: the spec stage leads straight to the implementer.
  assert.deepEqual(route("spec").effects, {
    humanGate: false,
    verify: false,
    createPr: false,
  });
  assert.equal(route("spec").to, "implement");
  assert.equal(route("implement").to, "review");
  assert.equal(route("implement").effects.verify, true);
  const review = run.nodes.find((n) => n.id === "review");
  assert.deepEqual(review.members, ["security", "code", "ux", "ui"]);
  assert.deepEqual(
    review.members.map(
      (id) => run.nodes.find((n) => n.id === id).profileSnapshot.seedKey,
    ),
    ["security-reviewer", "code-reviewer", "ux-reviewer", "ui-reviewer"],
  );
  assert.deepEqual(route("review", "fail"), {
    from: "review",
    to: "implement",
    condition: "fail",
    maxIterations: 2,
    continueSession: true,
    effects: { humanGate: false, verify: false, createPr: false },
  });
  assert.equal(route("review").to, "approve");
  assert.equal(
    run.nodes.find((n) => n.id === "approve").profileSnapshot.config.run.earlierVerdicts,
    true,
  );
  assert.deepEqual(route("approve"), {
    from: "approve",
    to: null,
    condition: "default",
    effects: { humanGate: false, verify: false, createPr: true },
  });
});

test("the UX and UI reviewers report into the stage report directory with the run's ports", () => {
  for (const [key, file] of [
    ["ux-reviewer", "UX-REVIEW.md"],
    ["ui-reviewer", "UI-REVIEW.md"],
  ]) {
    const text = role(key);
    assert.ok(text.includes(`${file} in the stage report directory`), key);
    for (const part of [
      "$AGENTPIER_PORT",
      "$AGENTPIER_BROWSER_SESSION",
      '"criterion"',
      "do not change application code",
    ])
      assert.ok(text.includes(part), `${key}: ${part}`);
  }
});

test("reviewers keep screenshots and other files out of the worktree", () => {
  for (const key of [
    "code-reviewer",
    "security-reviewer",
    "ux-reviewer",
    "ui-reviewer",
    "app-tester",
  ])
    assert.match(
      role(key),
      /screenshots, traces, logs and every other file you produce into the stage report directory and leave no new or changed file in the worktree/,
      key,
    );
});

test("the reworded seeds reference the spec's criteria and the stage's resources", () => {
  for (const key of ["code-reviewer", "security-reviewer", "app-tester"])
    assert.match(role(key), /acceptance criteria.*"criterion"/, key);
  assert.match(role("implementer"), /report each one in "criteria"/);
  assert.match(role("implementer"), /IMPLEMENTATION\.md in the stage report directory/);
  for (const key of ["implementer", "security-reviewer", "app-tester"])
    assert.match(role(key), /\$AGENTPIER_BROWSER_SESSION/, key);
  assert.match(role("planner"), /PLAN\.md in the stage report directory/);
  // Each earlier text differs from the current one, so a stored copy can be recognised.
  for (const [key, texts] of Object.entries(previousSeedRoles))
    for (const text of texts) assert.notEqual(text, role(key), key);
});
