import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRAITS } from "../../server/features/assistants/runtimes/runtime-traits.js";
import { traitDefaults, traitOf } from "../../web/features/assistants/runtime-traits.js";

// ADR 0007: the web app reads a runtime's traits from the agent's runtime view.

test("the web defaults are the server's", () => {
  assert.deepEqual(traitDefaults, DEFAULT_TRAITS);
});

test("traitOf reads the view and falls back to the default", () => {
  const info = {
    capabilities: { channelBots: { available: true, peopleApply: "restart" } },
  };
  assert.equal(traitOf(info, "channelBots", "peopleApply"), "restart");
  assert.equal(traitOf(info, "sessions", "chatFolders"), false);
  assert.equal(traitOf(undefined, "channelBots", "peopleApply"), "live");
  assert.equal(traitOf(null, "approvals", "allowlist"), "patterns");
  assert.equal(traitOf({ capabilities: {} }, "host", "process"), "shared");
  assert.deepEqual(traitOf({}, "approvals", "shellLevels"), [
    "off",
    "approval",
    "review",
    "full",
  ]);
});

test("traitOf refuses a trait nobody defined", () => {
  assert.throws(() => traitOf({}, "host", "kind"), TypeError);
  assert.throws(() => traitOf({}, "kanban", "board"), TypeError);
});
