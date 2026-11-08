import test from "node:test";
import assert from "node:assert/strict";
import {
  hermesCompiler,
  hermesConfigCapabilities,
} from "../../server/features/assistants/runtimes/hermes/hermes-compiler.js";
import { desiredState } from "../../server/features/assistants/agent-desired-state.js";
import { compilerContract } from "../helpers/runtime-port-config-contract.js";

// The Hermes compiler meets the same compiler contract as OpenClaw's
// (runtime-port-config-contract.js), before a Hermes host exists to run it.
compilerContract("Hermes", () => ({
  compiler: hermesCompiler,
  capabilities: hermesConfigCapabilities,
}));

test("Hermes offers the advanced settings it has an equivalent of", () => {
  assert.deepEqual(hermesConfigCapabilities.advancedSettings, { available: true });
  assert.deepEqual(
    hermesCompiler.advancedSettings.list.map(({ id, path }) => [id, path]),
    [
      ["thinkingDefault", "agent.reasoning_effort"],
      ["userTimezone", "HERMES_TIMEZONE"],
    ],
  );
});

test("Hermes compiles only desired states, one home per agent that is not archived", () => {
  assert.throws(() => hermesCompiler.compile({ desired: { agents: [] } }), TypeError);
  const profile = (id, extra = {}) => ({
    id,
    name: id,
    runtimeAgentId: `ap-${id}`,
    ...extra,
  });
  const desired = desiredState({
    profiles: [profile("a1"), profile("a2", { archivedAt: "2026-10-01T00:00:00.000Z" })],
  });
  assert.throws(
    () => hermesCompiler.compile({ desired, agents: [profile("a1")] }),
    TypeError,
  );
  assert.deepEqual(Object.keys(hermesCompiler.compile({ desired }).homes), ["ap-a1"]);
});
