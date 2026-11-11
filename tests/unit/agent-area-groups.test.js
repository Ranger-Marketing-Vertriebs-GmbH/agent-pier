import test from "node:test";
import assert from "node:assert/strict";
import {
  areaSections,
  areaStatus,
} from "../../web/features/assistants/groups/group-view.js";

const root = { id: "lead" },
  child = {
    id: "child",
    parentAssistantId: "lead",
    teamMemberId: "m",
    lifetime: "permanent",
  },
  alone = { id: "solo" };
const groups = [{ id: "work", name: "Work", assistantIds: [root.id] }];
test("areas keep members with their lead and expose an ungrouped section", () => {
  assert.deepEqual(areaSections([root, child, alone], groups), [
    { group: groups[0], agents: [root, child] },
    { group: null, agents: [alone] },
  ]);
  assert.deepEqual(areaSections([child], groups)[0].agents, [child]);
  assert.deepEqual(areaSections([root, child], [])[0].agents, [root, child]);
});
test("collapsed groups report hidden members' attention ahead of work", () => {
  const agents = [root, child, alone];
  assert.equal(
    areaStatus([root], agents, {
      child: { state: "waiting" },
      lead: { state: "working" },
    }),
    "attention",
  );
  assert.equal(
    areaStatus([root], agents, {
      solo: { state: "waiting" },
      child: { state: "working" },
    }),
    "working",
  );
  assert.equal(
    areaStatus([root], [root, { ...child, archivedAt: "now" }], {
      child: { pendingApprovals: 1 },
    }),
    null,
  );
  assert.equal(areaStatus([root], agents, { lead: { team: "awaiting" } }), "attention");
});
