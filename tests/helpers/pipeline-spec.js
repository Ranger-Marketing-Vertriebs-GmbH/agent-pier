import fs from "node:fs";
import path from "node:path";
import { fixture } from "./pipeline-engine.js";

// spec -> [gate] -> build -> review; a review failure loops back to build.
export function specFixture(
  t,
  { gate = false, continueSession = false, verify, reviewGate = false, options } = {},
) {
  const f = fixture(t, {
    ...(verify ? { verify } : {}),
    ...(options ? { options } : {}),
  });
  const original = f.definitions.snapshot;
  f.definitions.snapshot = () => {
    const snapshot = original();
    const base = snapshot.profiles.profile;
    const profile = (id, phaseKey) => ({ ...structuredClone(base), id, phaseKey });
    snapshot.profiles = {
      writer: profile("writer", "planning"),
      builder: profile("builder", "implementation"),
      reviewer: profile("reviewer", "review"),
    };
    snapshot.pipeline.graph = {
      entry: "spec",
      nodes: [
        { id: "spec", kind: "profile", profileId: "writer" },
        ...(gate ? [{ id: "approve-spec", kind: "gate" }] : []),
        { id: "build", kind: "profile", profileId: "builder" },
        ...(verify ? [{ id: "check", kind: "verify" }] : []),
        { id: "review", kind: "profile", profileId: "reviewer" },
        ...(reviewGate ? [{ id: "approve", kind: "gate" }] : []),
      ],
      edges: [
        ...(gate
          ? [
              { from: "spec", to: "approve-spec", condition: "default" },
              { from: "approve-spec", to: "build", condition: "default" },
            ]
          : [{ from: "spec", to: "build", condition: "default" }]),
        ...(verify
          ? [
              { from: "build", to: "check", condition: "default" },
              { from: "check", to: "review", condition: "default" },
            ]
          : [{ from: "build", to: "review", condition: "default" }]),
        ...(reviewGate ? [{ from: "review", to: "approve", condition: "default" }] : []),
        {
          from: "review",
          to: "build",
          condition: "fail",
          maxIterations: 1,
          ...(continueSession ? { continueSession: true } : {}),
        },
      ],
    };
    return snapshot;
  };
  return f;
}

export const SPEC = `# Spec

## Context
- server/app.js

## Requirements
- Validate input.

## Acceptance criteria
1. Empty input is rejected. Verify: npm test -- validation
2. Valid input is stored.
   Verify: open the list

## Out of scope
- Styling

## Assumptions
- [product decision] Rejected input shows no message.
- The API stays the same.
`;

export async function started(t, options) {
  const f = specFixture(t, options);
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  const current = () => f.engine.get(run.id);
  const turn = () => current().executionLog.at(-1);
  const write = (file, text) => fs.writeFileSync(path.join(run.workingDir, file), text);
  const read = (file) => fs.readFileSync(path.join(run.workingDir, file), "utf8");
  // The spec stage writes spec.md into its report directory and declares it.
  const writeSpec = async (text = SPEC, extra = {}) => {
    const file = `${turn().reportDir}/spec.md`;
    write(file, text);
    await f.end(
      {
        result: "pass",
        summary: "Spec written",
        artifacts: [{ path: file, role: "spec" }],
      },
      extra,
    );
    return file;
  };
  return { f, run, current, turn, write, read, writeSpec };
}

export const met = (criterion) => ({
  criterion,
  status: "met",
  evidence: `checked ${criterion}`,
});
