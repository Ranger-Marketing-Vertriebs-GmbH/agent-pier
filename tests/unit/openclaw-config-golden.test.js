import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compilerFor } from "../../server/features/assistants/runtimes/runtime-for.js";
import {
  desiredState,
  isDesiredState,
} from "../../server/features/assistants/agent-desired-state.js";
import { goldenPaths, goldenScenarios } from "../helpers/openclaw-golden-scenarios.js";

// The compiled openclaw.json of representative starts, compiled from AgentPier's
// desired state, byte for byte as the compiler wrote it from the stores' reads before
// it moved into the OpenClaw adapter (tests/fixtures/openclaw-golden/, written once
// from origin/main). A refactor of the compile path must not change it.
const fixtures = path.resolve(import.meta.dirname, "../fixtures/openclaw-golden");
const expected = (name) => fs.readFileSync(path.join(fixtures, `${name}.json`), "utf8");

for (const [name, scenario] of Object.entries(goldenScenarios))
  test(`golden openclaw.json: ${name}`, () => {
    const s = scenario();
    // What the composition root builds from the stores (assistant-graph.js).
    const desired = desiredState(s.teams);
    assert.ok(isDesiredState(desired));
    const config = compilerFor(null).compile({
      desired,
      existing: s.existing,
      paths: goldenPaths,
      port: s.port,
      token: s.token,
      overrides: s.overrides,
      runtime: { maintenance: s.maintenance },
      tls: s.tls ?? undefined,
      shell: s.shell,
      skillShadows: s.skillShadows,
    });
    assert.equal(`${JSON.stringify(config, null, 2)}\n`, expected(name));
  });

test("every golden fixture has its scenario", () => {
  const names = fs.readdirSync(fixtures).map((file) => path.basename(file, ".json"));
  assert.deepEqual(names.sort(), Object.keys(goldenScenarios).sort());
});
