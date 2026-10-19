import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  criterionId,
  parseVerdict,
} from "../../server/features/pipelines/stage-verdict.js";
import {
  missingCriteria,
  parseSpec,
  specContext,
} from "../../server/features/pipelines/run-spec.js";
import { seedProfiles } from "../../server/features/pipelines/profile-seeds.js";

const verdict = (extra) =>
  parseVerdict(JSON.stringify({ result: "pass", summary: "Done", ...extra }));

test("artifact roles keep only the spec role, in any case", () => {
  const { artifacts } = verdict({
    artifacts: [
      { path: ".pipeline/reports/spec/a/spec.md", role: " Spec " },
      { path: "REVIEW.md", role: "review" },
      { path: "notes.md", role: 7 },
      { path: "plain.md" },
    ],
  });
  assert.deepEqual(artifacts, [
    { path: ".pipeline/reports/spec/a/spec.md", role: "spec" },
    { path: "REVIEW.md" },
    { path: "notes.md" },
    { path: "plain.md" },
  ]);
});

test("criterion ids accept the spellings a model writes and nothing else", () => {
  for (const [value, id] of [
    ["AC1", "AC1"],
    ["ac-2", "AC2"],
    ["#AC 3", "AC3"],
    ["AC‑4", "AC4"],
    ["5", "AC5"],
    ["AC012", "AC12"],
    ["AC0", ""],
    ["R1-1", ""],
    ["AC1a", ""],
    ["", ""],
  ])
    assert.equal(criterionId(value), id, value);
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 999 }),
      (n) => criterionId(`AC${n}`) === `AC${n}`,
    ),
  );
});

test("verdict criteria need an id, met or not-met and evidence; the last entry wins", () => {
  const parsed = verdict({
    findings: [
      { title: "Covered", criterion: "ac1" },
      { title: "Loose", criterion: "nonsense" },
    ],
    criteria: [
      { criterion: "AC1", status: "not met", evidence: "first" },
      { criterion: "ac1", status: "MET", evidence: "second" },
      { criterion: "2", status: "unmet", evidence: "missing" },
    ],
  });
  assert.deepEqual(parsed.findings, [
    { title: "Covered", severity: "medium", criterion: "AC1" },
    { title: "Loose", severity: "medium" },
  ]);
  assert.deepEqual(parsed.criteria, [
    { criterion: "AC1", status: "met", evidence: "second" },
    { criterion: "AC2", status: "not-met", evidence: "missing" },
  ]);
  for (const criteria of [
    "AC1",
    [{ criterion: "x", status: "met", evidence: "e" }],
    [{ criterion: "AC1", status: "done", evidence: "e" }],
    [{ criterion: "AC1", status: "met", evidence: " " }],
  ])
    assert.throws(() => verdict({ criteria }), { status: 400 });
  assert.equal("criteria" in verdict({}), false);
});

test("a spec's numbered criteria and flagged assumptions are read from their sections", () => {
  const spec = parseSpec(
    [
      "# Spec",
      "## Context",
      "1. Not a criterion",
      "## Acceptance Criteria",
      "1. First outcome — Verify: npm test",
      "1. Second outcome",
      "   spans two lines (verify: open the page)",
      "   - a nested note",
      "```",
      "## Assumptions",
      "```",
      "3) Third: no check given",
      "## Out of scope",
      "- Nothing",
      "## Assumptions",
      "- [Product decision] Free users see the banner.",
      "* Product decision: dark mode stays off",
      "- Node 22 is available",
      "## Assumptions",
      "- ignored second section",
    ].join("\n"),
  );
  assert.deepEqual(spec.criteria, [
    { id: "AC1", text: "First outcome", verify: "npm test" },
    {
      id: "AC2",
      text: "Second outcome\nspans two lines",
      verify: "open the page)\n- a nested note\n```\n## Assumptions\n```",
    },
    { id: "AC3", text: "Third: no check given" },
  ]);
  assert.deepEqual(spec.assumptions, [
    { id: "A1", text: "Free users see the banner.", productDecision: true },
    { id: "A2", text: "dark mode stays off", productDecision: true },
    { id: "A3", text: "Node 22 is available", productDecision: false },
  ]);
  assert.deepEqual(parseSpec("no sections at all"), { criteria: [], assumptions: [] });
});

const run = (frozen) => ({
  spec: {
    path: ".pipeline/reports/spec/a/spec.md",
    nodeId: "spec",
    source: "stage",
    frozen,
    criteria: [
      { id: "AC1", text: "One", verify: "npm test" },
      { id: "AC2", text: "Two" },
    ],
  },
});
const node = (id, phaseKey) => ({ id, profileSnapshot: { phaseKey } });

test("later stages get the spec by path; the stage still writing it does not", () => {
  assert.deepEqual(specContext({}, node("build", "implementation")), []);
  assert.deepEqual(specContext(run(false), node("spec", "planning")), []);
  const [intro, label, criteria, report] = specContext(
    run(true),
    node("build", "implementation"),
  );
  assert.match(intro, /^Spec: \.pipeline\/reports\/spec\/a\/spec\.md is the contract/);
  assert.equal(label, "Acceptance criteria of the spec:");
  assert.deepEqual(JSON.parse(criteria), [
    { id: "AC1", criterion: "One", verify: "npm test" },
    { id: "AC2", criterion: "Two" },
  ]);
  assert.match(report, /report every acceptance criterion/);
  // A rerun of the spec stage after the freeze reads the frozen spec too.
  assert.equal(specContext(run(true), node("spec", "planning")).length, 4);
  assert.match(
    specContext(run(true), node("review", "review"))[3],
    /each acceptance criterion you implemented or checked/,
  );
  // A long criteria list stays bounded and says how many it left out.
  const long = run(true);
  long.spec.criteria = Array.from({ length: 50 }, (_, i) => ({
    id: `AC${i + 1}`,
    text: "x".repeat(400),
  }));
  const parts = specContext(long, node("build", "implementation"));
  assert.ok(Buffer.byteLength(parts[2]) <= 8 * 1024);
  assert.match(parts[1], /\(\d+ more in the file\)/);
});

test("only an implementation stage must report every criterion", () => {
  const criteria = [{ criterion: "AC2", status: "met", evidence: "e" }];
  assert.deepEqual(
    missingCriteria(run(true), node("build", "implementation"), { criteria }),
    ["AC1"],
  );
  assert.deepEqual(missingCriteria(run(true), node("review", "review"), {}), []);
  assert.deepEqual(missingCriteria({}, node("build", "implementation"), {}), []);
});

test("the seeded spec writer declares spec.md with the spec role", () => {
  const writer = seedProfiles("2026-10-19T00:00:00Z").find(
    (p) => p.seedKey === "spec-writer",
  );
  assert.equal(writer.id, "seed-spec-writer");
  assert.equal(writer.phaseKey, "planning");
  assert.equal(writer.config.run.autonomous, true);
  for (const part of [
    "spec.md in the stage report directory",
    "## Acceptance criteria",
    "Verify:",
    "[product decision]",
    '"role":"spec"',
  ])
    assert.ok(writer.config.prompts.role.includes(part), part);
});
