import test from "node:test";
import assert from "node:assert/strict";
import { agentSshFixture, hostId, otherHostId } from "../helpers/agent-ssh-fixture.js";

test("SSH grants are validated, sorted and kept when a save leaves them out", async (t) => {
  const f = await agentSshFixture(t);
  assert.deepEqual(f.workflows.access.get(f.id).sshAccesses, []);
  const saved = f.grant([
    { accessId: otherHostId, mode: "trusted" },
    { accessId: hostId, mode: "approval" },
  ]);
  assert.deepEqual(saved.sshAccesses, [
    { accessId: hostId, mode: "approval" },
    { accessId: otherHostId, mode: "trusted" },
  ]);
  // The MCP path and older clients send no sshAccesses; the grants stay.
  const kept = f.workflows.access.save(f.id, f.policy, saved.revision);
  assert.deepEqual(kept.sshAccesses, saved.sshAccesses);
  assert.equal(kept.revision, saved.revision + 1);
  assert.equal(f.workflows.access.sshGrant(f.id, otherHostId).mode, "trusted");
  assert.equal(f.workflows.access.sshGrant(f.id, "nope"), null);
  assert.equal(f.workflows.access.hasSshGrants(f.id), true);
  assert.deepEqual([...f.workflows.access.sshAgents()], [f.id]);
});

test("invalid SSH grants are refused before anything is written", async (t) => {
  const f = await agentSshFixture(t);
  const save = (sshAccesses) =>
    f.workflows.access.save(f.id, { ...f.policy, sshAccesses }, 0);
  const many = Array.from({ length: 31 }, (_, n) => ({
    accessId: `${n}`.padStart(8, "0"),
    mode: "approval",
  }));
  for (const value of [
    "all",
    many,
    [{ accessId: hostId, mode: "always" }],
    [{ accessId: hostId }],
    [{ accessId: hostId, mode: "approval", key: "x" }],
    [
      { accessId: hostId, mode: "approval" },
      { accessId: hostId, mode: "trusted" },
    ],
  ])
    assert.throws(() => save(value), { status: 400 }, JSON.stringify(value).slice(0, 80));
  assert.throws(() => save([{ accessId: "unknown-host", mode: "approval" }]), {
    status: 409,
    key: "sshHostUnavailable",
  });
  assert.equal(f.workflows.access.get(f.id).revision, 0);
});

test("temporary members cannot hold SSH grants", async (t) => {
  const f = await agentSshFixture(t);
  const task = f.member({ lifetime: "task" });
  assert.throws(() => f.grant([{ accessId: hostId, mode: "approval" }], task.id), {
    status: 403,
  });
});

test("an agent with a bot for other people cannot receive SSH grants", async (t) => {
  const f = await agentSshFixture(t);
  f.services.assistantTelegramSenders = { connected: (id) => id === f.id };
  assert.throws(() => f.grant([{ accessId: hostId, mode: "approval" }]), {
    status: 409,
    key: "telegramSendersSsh",
  });
});

test("grant changes are audited with ids and modes only", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "approval" }]);
  f.grant([
    { accessId: hostId, mode: "trusted" },
    { accessId: otherHostId, mode: "routines" },
  ]);
  const changes = f.audit.filter(
    (e) => e.action === "assistant.updated" && e.details.kind === "ssh-grants",
  );
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1].details, {
    kind: "ssh-grants",
    revision: 2,
    added: [otherHostId],
    removed: [],
    modeChanged: [{ accessId: hostId, from: "approval", to: "trusted" }],
    reason: "owner",
  });
  assert.equal(changes[1].resourceId, f.id);
  // A save that does not touch the grants writes no grant audit.
  f.workflows.access.save(f.id, f.policy, 2);
  assert.equal(f.audit.filter((e) => e.details.kind === "ssh-grants").length, 2);
});

test("the workspace catalog lists SSH hosts, or null while the catalog is unreadable", async (t) => {
  const f = await agentSshFixture(t);
  f.catalog.rows.get(otherHostId).projectId = f.project.id;
  const { sshHosts } = f.workflows.access.catalog();
  assert.deepEqual(
    sshHosts.map((h) => [h.name, h.projectName]),
    [
      ["opnsense", null],
      ["nas-01", f.project.name],
    ],
  );
  assert.equal("keyId" in sshHosts[0], false);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  f.catalog.failing = true;
  assert.equal(f.workflows.access.catalog().sshHosts, null);
  // Saving other fields never drops the grants while hosts cannot be read.
  const kept = f.workflows.access.save(f.id, { ...f.policy, memoryWrite: false }, 1);
  assert.deepEqual(kept.sshAccesses, [{ accessId: hostId, mode: "trusted" }]);
  assert.throws(
    () =>
      f.workflows.access.save(
        f.id,
        { ...f.policy, sshAccesses: [{ accessId: hostId, mode: "approval" }] },
        2,
      ),
    { status: 503, key: "sshHostUnavailable" },
  );
});

test("revokeSsh removes a host from every agent in one transaction", async (t) => {
  const f = await agentSshFixture(t);
  const m = f.member();
  f.grant([
    { accessId: hostId, mode: "approval" },
    { accessId: otherHostId, mode: "trusted" },
  ]);
  f.grant([{ accessId: hostId, mode: "trusted" }], m.id);
  let during = 0;
  const changed = f.workflows.access.revokeSsh(hostId, () => during++);
  assert.equal(during, 1);
  assert.deepEqual(changed.sort(), [f.id, m.id].sort());
  assert.deepEqual(f.workflows.access.get(f.id).sshAccesses, [
    { accessId: otherHostId, mode: "trusted" },
  ]);
  assert.deepEqual(f.workflows.access.get(m.id).sshAccesses, []);
  assert.equal(f.workflows.access.get(f.id).revision, 2);
  assert.equal(f.workflows.access.get(m.id).revision, 2);
  assert.deepEqual([...f.workflows.access.sshAgents()], [f.id]);
  assert.equal(f.audit.filter((e) => e.details.reason === "host-removed").length, 2);
});

test("a failing step inside revokeSsh leaves every grant as it was", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "approval" }]);
  assert.throws(() =>
    f.workflows.access.revokeSsh(hostId, () => {
      throw Error("cancel failed");
    }),
  );
  assert.deepEqual(f.workflows.access.get(f.id).sshAccesses, [
    { accessId: hostId, mode: "approval" },
  ]);
  assert.equal(f.workflows.access.get(f.id).revision, 1);
});
