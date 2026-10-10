import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTeamPolicy,
  normalizeTeamSettings,
} from "../../server/features/assistants/team-policy.js";
test("team limits accept all members but reject invalid capacity and hidden grants", () => {
  const policy = normalizeTeamPolicy({});
  assert.deepEqual(policy, {
    revision: 1,
    autonomous: false,
    maxMembers: 4,
    runTimeoutMinutes: 10,
  });
  for (const input of [
    { maxMembers: 0 },
    { maxMembers: 9 },
    { runTimeoutMinutes: 0 },
    { runTimeoutMinutes: 61 },
    { autonomous: "yes" },
    { grants: ["all"] },
  ])
    assert.throws(() => normalizeTeamPolicy(input), { status: 400 });
  assert.equal(
    normalizeTeamSettings({ hostMaxConcurrent: 8 }, [{ maxMembers: 8 }])
      .hostMaxConcurrent,
    8,
  );
  assert.throws(
    () => normalizeTeamSettings({ hostMaxConcurrent: 4 }, [{ maxMembers: 8 }]),
    { status: 409 },
  );
});
