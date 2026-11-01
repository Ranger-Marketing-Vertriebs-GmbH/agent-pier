import test from "node:test";
import assert from "node:assert/strict";
import { capabilityOf, unavailableText } from "../../web/components/capability-gate.js";
import {
  runtimeLabel,
  runtimeName,
  surfaceCapabilities,
} from "../../web/features/assistants/runtime-capabilities.js";
import { RUNTIME_CAPABILITIES } from "../../server/features/assistants/runtimes/agent-runtime.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

// ADR 0006: a capability the agent's runtime lacks is shown with its reason, never hidden.
const all = (state) =>
  Object.fromEntries(RUNTIME_CAPABILITIES.map((name) => [name, state]));
const openClaw = {
  id: "openclaw",
  name: "OpenClaw",
  version: "2026.10.3",
  capabilities: all({ available: true }),
};
// A fake runtime without routines and with a capability it lacks for a reason it names.
const partial = {
  id: "later",
  name: "Hermes",
  version: null,
  capabilities: {
    ...all({ available: true }),
    routines: { available: false, reason: "notYet" },
    browser: { available: false, reason: "runtimeUnknown" },
  },
};

test("every settings surface needs a capability the runtime port defines", () => {
  for (const [surface, capability] of Object.entries(surfaceCapabilities))
    assert.ok(RUNTIME_CAPABILITIES.includes(capability), surface);
  for (const surface of [
    "shell",
    "routines",
    "skills",
    "browser",
    "mcp",
    "memory",
    "models",
    "channels",
  ])
    assert.ok(surface in surfaceCapabilities, surface);
});

test("OpenClaw offers every capability, so no surface changes", () => {
  for (const capability of Object.values(surfaceCapabilities)) {
    assert.deepEqual(capabilityOf(openClaw, capability), { available: true });
    assert.equal(unavailableText(openClaw, capability), "");
  }
  // An agent view without runtime details (an older server) changes nothing either.
  assert.equal(unavailableText(undefined, "skills"), "");
  assert.equal(unavailableText({ name: "OpenClaw" }, "skills"), "");
});

test("a lacking capability names the runtime and its translated reason", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("en", { persist: false });
  assert.deepEqual(capabilityOf(partial, "routines"), {
    available: false,
    reason: "notYet",
  });
  assert.equal(unavailableText(partial, "skills"), "");
  // A reason without its own text falls back to the runtime's name.
  assert.equal(unavailableText(partial, "routines"), "Hermes does not offer this.");
  assert.equal(
    unavailableText(partial, "browser"),
    "Not available: this AgentPier has no runtime “Hermes”.",
  );
  assert.equal(
    unavailableText({ capabilities: partial.capabilities }, "routines"),
    "The agent's runtime does not offer this.",
  );
  // Inherited keys of the catalog are no reasons.
  assert.equal(
    unavailableText(
      {
        name: "Hermes",
        capabilities: { skills: { available: false, reason: "toString" } },
      },
      "skills",
    ),
    "Hermes does not offer this.",
  );
  setLanguage("de", { persist: false });
  assert.equal(unavailableText(partial, "routines"), "Hermes bietet das nicht an.");
  assert.match(unavailableText(partial, "browser"), /„Hermes“/);
});

test("an agent's runtime is named with its version once known", () => {
  assert.equal(runtimeName({ runtimeInfo: openClaw }), "OpenClaw");
  assert.equal(runtimeLabel({ runtimeInfo: openClaw }), "OpenClaw 2026.10.3");
  assert.equal(runtimeLabel({ runtimeInfo: partial }), "Hermes");
  // Agents from before the field ran on OpenClaw.
  assert.equal(runtimeName({}), "OpenClaw");
  assert.equal(runtimeLabel(undefined), "OpenClaw");
});
