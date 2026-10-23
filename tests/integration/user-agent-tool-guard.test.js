import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { nativeWriteGuard } from "../helpers/native-write-guard.js";
import { lockedCoreTools } from "../../server/features/assistants/team-plugin/tool-guard.js";
import {
  delegationTools,
  lockedTools,
  memberTeamTools,
} from "../../server/features/assistants/native-capabilities.js";

const userAccess = {
  mode: "own",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};

test("the plugin hook covers every locked core tool; the rest are plugin tools", () => {
  for (const tool of lockedCoreTools) assert.ok(lockedTools.includes(tool), tool);
  assert.deepEqual(
    lockedTools.filter((tool) => !lockedCoreTools.includes(tool)).sort(),
    ["agentpier_ssh", ...delegationTools, ...memberTeamTools].sort(),
  );
});

test("the plugin refuses a user agent's exec and session tools at run time", async (t) => {
  const f = await workflowFixture(t);
  const guard = await nativeWriteGuard(t, f);
  assert.deepEqual(guard.locked.options.matcher, lockedCoreTools);
  // An owner agent keeps its tools.
  for (const tool of lockedCoreTools) assert.equal(await guard.tool(tool), true, tool);
  // A forged body makes it a user agent, whatever its compiled entry holds.
  const body = { ...f.store.storedAssistant(f.id), userAccess, shell: "full" };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  for (const tool of lockedCoreTools) assert.equal(await guard.tool(tool), false, tool);
  assert.equal(await guard.tool("exec", { agentId: guard.agentId }), false);
  // A closed bridge refuses as well.
  await guard.bridge.close();
  const owner = { ...body };
  delete owner.userAccess;
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(owner), f.id);
  assert.equal(await guard.tool("exec"), false);
});
