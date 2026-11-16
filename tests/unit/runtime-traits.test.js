import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TRAITS,
  RUNTIME_TRAITS,
  resolveTraits,
} from "../../server/features/assistants/runtimes/runtime-traits.js";

test("the defaults are OpenClaw's behaviour", () => {
  assert.deepEqual(DEFAULT_TRAITS, {
    approvals: { shellLevels: ["off", "approval", "full"], allowlist: "patterns" },
    agentFiles: { memoryFormat: "markdown", dreaming: "host" },
    models: { chatgptLogin: "any" },
    channelBots: { peopleApply: "live" },
    sessions: { chatFolders: false },
    host: { process: "shared", install: "builtin" },
  });
});

test("stated values replace defaults, the rest stays", () => {
  const traits = resolveTraits({ agentFiles: { memoryFormat: "entries" } });
  assert.equal(traits.agentFiles.memoryFormat, "entries");
  assert.equal(traits.agentFiles.dreaming, "host");
  assert.ok(Object.isFrozen(traits) && Object.isFrozen(traits.agentFiles));
  assert.ok(Object.isFrozen(traits.approvals.shellLevels));
});

test("a stated list is copied, so the statement cannot change it later", () => {
  const stated = ["off", "full"];
  const traits = resolveTraits({ approvals: { shellLevels: stated } });
  stated.push("every");
  assert.deepEqual(traits.approvals.shellLevels, ["off", "full"]);
});

test("a wrong statement fails with the trait's name", () => {
  assert.throws(() => resolveTraits({ kanban: {} }), /kanban/);
  assert.throws(() => resolveTraits({ host: { kind: "hermes" } }), /host\.kind/);
  assert.throws(() => resolveTraits({ host: { process: "fleet" } }), /host\.process/);
  assert.throws(
    () => resolveTraits({ approvals: { shellLevels: ["off", "sudo"] } }),
    /approvals\.shellLevels/,
  );
  assert.throws(
    () => resolveTraits({ approvals: { shellLevels: ["off", "off"] } }),
    /approvals\.shellLevels/,
  );
  assert.throws(() => resolveTraits({ sessions: { chatFolders: "yes" } }), TypeError);
});

test("every schema entry accepts its own default", () => {
  for (const traits of Object.values(RUNTIME_TRAITS))
    for (const { default: value, allows } of Object.values(traits))
      assert.equal(allows(value), true);
});
