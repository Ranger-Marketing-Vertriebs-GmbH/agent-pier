import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  restrictRuntimeOptions,
  runtimeOptionsOf,
  validateRuntimeOptions,
} from "../../server/features/assistants/runtimes/runtime-options.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { createAgent } from "../../server/features/assistants/agent-creation.js";

// OpenClaw's memory wiki as a per-agent option (ADR 0007, step 7b):
// `runtimeOptions.openclaw.memoryWiki`, only for the owner's own agents. Refused for an
// agent shared with users, a user's own agent and a temporary team member on every
// write; an agent that comes to serve users afterwards loses the stored value, and no
// read hands it to a compiler.

const wiki = { openclaw: { memoryWiki: true } };
const own = (extra = {}) => ({
  id: "o1",
  model: { connectionId: "c", modelId: "m" },
  ...extra,
});
const shared = {
  mode: "shared",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};
const users = { mode: "own", members: [{ userId: "u1", level: "chat" }], released: [] };
const member = { teamMemberId: "tm-1", lifetime: "task", parentAssistantId: "lead" };
const refused = (fn, key, status = 409) =>
  assert.throws(fn, (error) => error.key === key && error.status === status, key);

test("an owner's own agent may keep a wiki; off stores nothing", () => {
  assert.deepEqual(validateRuntimeOptions(own(), wiki), wiki);
  assert.deepEqual(
    validateRuntimeOptions(own(), { openclaw: { memoryWiki: false } }),
    {},
  );
  assert.deepEqual(validateRuntimeOptions(own(), { openclaw: {} }), {});
  // A permanent member is the owner's own agent too.
  assert.deepEqual(
    validateRuntimeOptions(own({ teamMemberId: "tm", lifetime: "permanent" }), wiki),
    wiki,
  );
});

test("the wiki is refused for shared agents, users' agents and task members", () => {
  refused(
    () => validateRuntimeOptions(own({ userAccess: shared }), wiki),
    "memoryWikiShared",
  );
  refused(
    () => validateRuntimeOptions(own({ userAccess: users }), wiki),
    "memoryWikiUserAgent",
  );
  refused(() => validateRuntimeOptions(own(member), wiki), "memoryWikiTaskMember");
  // Restating "off" is no change and passes for anyone.
  assert.deepEqual(
    validateRuntimeOptions(own({ userAccess: shared }), {
      openclaw: { memoryWiki: false },
    }),
    {},
  );
});

test("a malformed wiki value and unknown keys are refused", () => {
  refused(
    () => validateRuntimeOptions(own(), { openclaw: { memoryWiki: "yes" } }),
    "optionsInvalid",
    400,
  );
  refused(
    () => validateRuntimeOptions(own(), { openclaw: { memoryWiki: true, vault: "x" } }),
    "optionsUnknownKey",
    400,
  );
  // Hermes agents never take OpenClaw's options.
  refused(
    () => validateRuntimeOptions(own({ runtime: "hermes" }), wiki),
    "optionsOtherRuntime",
    400,
  );
});

test("a read leaves the wiki out for an agent that may not keep one", () => {
  assert.deepEqual(runtimeOptionsOf(own({ runtimeOptions: wiki })), { memoryWiki: true });
  for (const extra of [{ userAccess: shared }, { userAccess: users }, member])
    assert.deepEqual(runtimeOptionsOf(own({ runtimeOptions: wiki, ...extra })), {});
  for (const broken of [{ openclaw: { memoryWiki: "true" } }, { openclaw: 1 }, null])
    assert.deepEqual(runtimeOptionsOf(own({ runtimeOptions: broken })), {});
  // The desired state carries what the compile may grant, never more.
  const desired = desiredAgent({
    ...own({ runtimeOptions: wiki, userAccess: shared }),
    runtimeAgentId: "ap-o1",
  });
  assert.deepEqual(desired.runtimeOptions, {});
});

test("restrictRuntimeOptions drops a wiki the agent may no longer keep", () => {
  const record = own({ runtimeOptions: wiki });
  assert.equal(restrictRuntimeOptions(record), record);
  const became = restrictRuntimeOptions({ ...record, userAccess: shared });
  assert.equal("runtimeOptions" in became, false);
  assert.deepEqual(became.userAccess, shared);
  // Another runtime's stored options are not this agent's to change.
  const kept = restrictRuntimeOptions({
    ...record,
    userAccess: users,
    runtimeOptions: { ...wiki, hermes: { x: 1 } },
  });
  assert.deepEqual(kept.runtimeOptions, { hermes: { x: 1 } });
});

test("assigning an agent to users drops its stored wiki", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-option-"));
  const store = new AssistantStore({ dataDir: dir });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const created = store.createAssistant({
    name: "Owl",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
  });
  const on = store.updateAssistant(
    created.id,
    { runtimeOptions: wiki },
    created.revision,
  );
  assert.deepEqual(store.getAssistant(created.id).runtimeOptions, wiki);
  store.setUserAccess(created.id, shared, on.revision);
  assert.equal(store.getAssistant(created.id).runtimeOptions, undefined);
});

test("a create, a duplicate or a user's create with the wiki is checked too", async () => {
  const reached = new Error("validated");
  const service = {
    runtime: {},
    admit: (fn) => fn(),
    models: {
      listCapabilities: () => [],
      resolve: async () => {
        throw reached;
      },
    },
  };
  const body = {
    name: "Owl",
    instructions: "",
    shell: "off",
    model: { connectionId: "c", modelId: "m" },
    runtimeOptions: wiki,
  };
  await assert.rejects(createAgent(service, body), (error) => error === reached);
  await assert.rejects(
    createAgent(service, body, { userAccess: users }),
    (error) => error.key === "memoryWikiUserAgent",
  );
});
