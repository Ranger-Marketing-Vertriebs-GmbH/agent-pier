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
    usage: "suggest",
    maxMembers: 4,
    runTimeoutMinutes: 10,
    memberShellSsh: false,
  });
  assert.equal(normalizeTeamPolicy({ memberShellSsh: true }).memberShellSsh, true);
  for (const usage of ["onRequest", "suggest", "autonomous"])
    assert.equal(normalizeTeamPolicy({ usage }).usage, usage);
  for (const input of [
    { maxMembers: 0 },
    { maxMembers: 9 },
    { runTimeoutMinutes: 0 },
    { runTimeoutMinutes: 61 },
    { autonomous: "yes" },
    { memberShellSsh: "yes" },
    { usage: "always" },
    { usage: null },
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
    { status: 409, key: "hostCapacity" },
  );
});
