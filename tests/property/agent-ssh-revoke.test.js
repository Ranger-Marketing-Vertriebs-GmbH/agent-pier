import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { agentSshFixture, hostId, otherHostId } from "../helpers/agent-ssh-fixture.js";

test("after a revoke no agent references the host and other grants are untouched", async (t) => {
  const f = await agentSshFixture(t);
  const agents = [f.id, f.member().id, f.member({ name: "Echo" }).id];
  const grantSet = fc.subarray([
    { accessId: hostId, mode: "approval" },
    { accessId: otherHostId, mode: "routines" },
  ]);
  await fc.assert(
    fc.asyncProperty(
      fc.tuple(grantSet, grantSet, grantSet),
      fc.constantFrom(hostId, otherHostId),
      async (sets, revoked) => {
        agents.forEach((id, n) => f.grant(sets[n], id));
        f.workflows.access.revokeSsh(revoked);
        agents.forEach((id, n) => {
          const now = f.workflows.access.get(id).sshAccesses;
          assert.equal(
            now.some((g) => g.accessId === revoked),
            false,
          );
          assert.deepEqual(
            now,
            sets[n].filter((g) => g.accessId !== revoked),
          );
        });
      },
    ),
    { seed: Number(process.env.FC_SEED || 86016), numRuns: 40 },
  );
});
