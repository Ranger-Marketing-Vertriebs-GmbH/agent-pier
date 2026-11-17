import test from "node:test";
import assert from "node:assert/strict";
import {
  wikiLock,
  wikiOpen,
  withWiki,
} from "../../web/features/assistants/runtimes/openclaw/wiki-rules.js";
import { agentPageAllowed } from "../../web/features/assistants/settings/agent-settings-fields.js";
import { runtimePageIds } from "../../web/features/assistants/settings-routes.js";

// OpenClaw's memory wiki in the web app (ADR 0007, step 7b): the switch is locked with
// the reason the server refuses it for, and the wiki page exists only for an agent
// whose view names it.
const shared = { mode: "shared", members: [], released: [] };

test("the switch is locked for shared agents, users' agents and task members", () => {
  assert.equal(wikiLock({ id: "a" }), null);
  assert.equal(wikiLock({ id: "a", teamMemberId: "t", lifetime: "permanent" }), null);
  assert.equal(wikiLock({ userAccess: shared }), "shared");
  assert.equal(wikiLock({ userAccess: { ...shared, mode: "own" } }), "userAgent");
  assert.equal(wikiLock({ teamMemberId: "t", lifetime: "task" }), "taskMember");
});

test("the draft holds the wiki on, or nothing", () => {
  assert.deepEqual(withWiki({}, true), { memoryWiki: true });
  assert.deepEqual(withWiki({ memoryWiki: true }, false), {});
  assert.deepEqual(withWiki(undefined, false), {});
});

test("the wiki page exists only while the agent's view names it", () => {
  assert.deepEqual(runtimePageIds, ["wiki"]);
  const keeper = { id: "a", runtimePages: ["wiki"] };
  assert.equal(wikiOpen(keeper), true);
  assert.equal(wikiOpen({ id: "a" }), false);
  assert.equal(agentPageAllowed(keeper, "wiki"), true);
  assert.equal(agentPageAllowed({ id: "a" }, "wiki"), false);
  // A temporary member's view never names it; nor may it open the page.
  assert.equal(
    agentPageAllowed({ ...keeper, teamMemberId: "t", lifetime: "task" }, "wiki"),
    false,
  );
});
