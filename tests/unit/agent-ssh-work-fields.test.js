import test from "node:test";
import assert from "node:assert/strict";
import {
  accessKeys,
  agentPageAllowed,
  resolveAgentLocation,
  savedSshApproval,
  setSshGrant,
  sshSummary,
  workBody,
  workServer,
} from "../../web/features/assistants/settings/agent-settings-fields.js";

test("SSH grants are sorted, toggled and counted against the catalog", () => {
  const grants = setSshGrant([], "b", "approval");
  assert.deepEqual(setSshGrant(grants, "a", "trusted"), [
    { accessId: "a", mode: "trusted" },
    { accessId: "b", mode: "approval" },
  ]);
  assert.deepEqual(setSshGrant(grants, "b", "trusted"), [
    { accessId: "b", mode: "trusted" },
  ]);
  assert.deepEqual(setSshGrant(grants, "b", null), []);
  assert.deepEqual(
    sshSummary(
      [
        { accessId: "a", mode: "trusted" },
        { accessId: "c", mode: "approval" },
        { accessId: "gone", mode: "trusted" },
      ],
      [{ id: "a" }, { id: "c" }],
    ),
    { count: 2, trusted: 1 },
  );
  assert.ok(accessKeys.includes("sshAccesses"));
  assert.equal(agentPageAllowed({ id: "home" }, "ssh"), true);
  assert.deepEqual(
    resolveAgentLocation({ id: "home" }, { agentTab: "work", agentPage: "ssh" }).page,
    "ssh",
  );
  assert.equal(
    agentPageAllowed({ id: "m", teamMemberId: "m", lifetime: "task" }, "ssh"),
    false,
  );
});

test("a save drops removed hosts, but never while the catalog is unreadable", () => {
  const values = workServer(
    {
      revision: 2,
      sshAccesses: [
        { accessId: "gone", mode: "approval" },
        { accessId: "a", mode: "trusted" },
      ],
    },
    null,
  );
  assert.deepEqual(values.sshAccesses, [
    { accessId: "a", mode: "trusted" },
    { accessId: "gone", mode: "approval" },
  ]);
  const body = (sshHostIds, changed = ["sshAccesses"]) =>
    workBody({
      values,
      changed,
      revisions: { access: 2 },
      withTeam: false,
      sshHostIds,
    }).access;
  assert.deepEqual(body(["a"]).sshAccesses, [{ accessId: "a", mode: "trusted" }]);
  assert.deepEqual(body(null).sshAccesses, values.sshAccesses);
  // Unchanged grants stay out, so an unreadable SSH catalog cannot fail the save.
  assert.equal("sshAccesses" in body(null, ["publish"]), false);
  assert.equal("sshAccesses" in body(["a"], ["publish"]), false);
});

test("the plain ssh approval hint follows the saved grants of listed hosts only", () => {
  const hosts = [{ id: "a" }, { id: "b" }];
  const base = (sshAccesses) => ({ sshAccesses });
  assert.equal(
    savedSshApproval(base([{ accessId: "a", mode: "approval" }]), hosts),
    true,
  );
  assert.equal(
    savedSshApproval(base([{ accessId: "a", mode: "trusted" }]), hosts),
    false,
  );
  // A removed host's approval grant, or no catalog yet: no hint.
  assert.equal(
    savedSshApproval(base([{ accessId: "x", mode: "approval" }]), hosts),
    false,
  );
  assert.equal(
    savedSshApproval(base([{ accessId: "a", mode: "approval" }]), null),
    false,
  );
  assert.equal(savedSshApproval(undefined, hosts), false);
});
