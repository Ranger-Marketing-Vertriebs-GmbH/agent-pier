import test from "node:test";
import assert from "node:assert/strict";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import {
  agentSshFixture,
  hostId,
  otherHostId,
  waitFor,
} from "../helpers/agent-ssh-fixture.js";

const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("expected a refusal");
};
const marker = "SECRET-MARKER-86";
const rows = (f, id = f.id) =>
  f.workflows.store.list(id).filter((a) => a.payload.action === "ssh");

test("an owner turn runs a command on a trusted host and leaves one settled row", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  const result = await f.execute(
    f.ownTurn(),
    `process.stdout.write("up 3 days") // ${marker}`,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.stdout, "up 3 days");
  assert.equal(result.exitCode, 0);
  assert.equal(result.untrusted, true);
  assert.equal(result.host, "opnsense");
  assert.equal(result.accessId, hostId);
  assert.match(result.notice, /untrusted external data from opnsense/);
  const [row] = rows(f);
  assert.equal(rows(f).length, 1);
  assert.equal(row.settled, true);
  assert.equal(row.state, "completed");
  assert.equal(row.payload.trusted, true);
  assert.equal(row.payload.command, undefined);
  assert.equal(row.payload.originClass, "owner");
  assert.ok(row.chatNotes.result.at > 0);
  const executed = f.audit.filter((e) => e.action === "ssh.executed");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].details.authorizedBy, "mode");
  assert.equal(executed[0].details.mode, "trusted");
  assert.match(executed[0].details.commandSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(f.audit).includes(marker), false);
  assert.equal(JSON.stringify(f.audit).includes("up 3 days"), false);
});

test("hosts lists only granted hosts and never key material", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "approval" }]);
  assert.deepEqual((await f.call(f.ownTurn(), { action: "hosts" })).hosts, [
    {
      accessId: hostId,
      name: "opnsense",
      host: "opnsense.invalid",
      port: 22,
      username: "root",
      hostFingerprint: "SHA256:opnsense",
      mode: "approval",
      usable: true,
    },
  ]);
});

test("a routine sees only routines hosts as usable and runs only there", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([
    { accessId: hostId, mode: "routines" },
    { accessId: otherHostId, mode: "trusted" },
  ]);
  const { hosts } = await f.call(f.routineTurn(), { action: "hosts" });
  assert.deepEqual(
    hosts.map((h) => [h.name, h.usable, h.reason]),
    [
      ["opnsense", true, undefined],
      ["nas-01", false, "ROUTINE_NOT_TRUSTED"],
    ],
  );
  assert.equal((await f.execute(f.routineTurn(), "process.exit(0)")).status, "completed");
  assert.equal(
    await code(f.execute(f.routineTurn(), "process.exit(0)", otherHostId)),
    "SSH_ROUTINE_NOT_TRUSTED",
  );
  assert.equal(rows(f)[0].origin.kind, "routine");
});

test("refusals name a stable code and are audited", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  const run = (origin, accessId) =>
    f.execute(f.ownTurn(origin), "process.exit(0)", accessId);
  assert.equal(await code(run(undefined, otherHostId)), "SSH_NOT_GRANTED");
  assert.equal(
    await code(run({ kind: "telegram", forwarded: true })),
    "SSH_ORIGIN_REFUSED",
  );
  assert.equal(
    await code(run({ kind: "member-result", requestId: "r" })),
    "SSH_ORIGIN_REFUSED",
  );
  f.catalog.rows.delete(hostId);
  assert.equal(await code(run()), "SSH_HOST_UNAVAILABLE");
  assert.deepEqual(
    f.audit.filter((e) => e.action === "ssh.denied").map((e) => e.details.code),
    [
      "SSH_NOT_GRANTED",
      "SSH_ORIGIN_REFUSED",
      "SSH_ORIGIN_REFUSED",
      "SSH_HOST_UNAVAILABLE",
    ],
  );
  assert.equal(rows(f).length, 0);
  assert.equal(f.catalog.connections, 0);
});

test("an accessId that is not an id is refused and still audited", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  for (const accessId of ["../../etc/passwd", "!".repeat(100), "acc id"])
    assert.equal(
      await code(f.execute(f.ownTurn(), "process.exit(0)", accessId)),
      "SSH_NOT_GRANTED",
    );
  const denied = f.audit.filter((e) => e.action === "ssh.denied");
  assert.equal(denied.length, 3);
  for (const e of denied) {
    assert.equal(e.resourceId, undefined);
    assert.equal(e.details.accessId, undefined);
  }
});

test("invalid input is refused before anything runs", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  for (const input of [
    { action: "execute", accessId: hostId },
    { action: "execute", accessId: hostId, command: "   " },
    { action: "execute", accessId: hostId, command: "a\0b" },
    { action: "execute", accessId: hostId, command: "x".repeat(16385) },
    { action: "execute", accessId: hostId, command: "é".repeat(8193) },
    { action: "execute", accessId: hostId, command: "true", timeoutSeconds: 0 },
    { action: "execute", accessId: hostId, command: "true", timeoutSeconds: 121 },
    { action: "execute", accessId: hostId, command: "true", timeoutSeconds: 1.5 },
    { action: "execute", accessId: "x".repeat(101), command: "true" },
    { action: "execute", command: "true" },
    { action: "execute", accessId: hostId, command: "true", extra: 1 },
    { action: "hosts", accessId: hostId },
    { action: "scan" },
    null,
  ])
    assert.equal(
      await code(f.call(f.ownTurn(), input)),
      "INVALID_INPUT",
      JSON.stringify(input)?.slice(0, 60),
    );
  assert.equal(f.catalog.connections, 0);
});

test("a missing ssh program reads as an unavailable host", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  f.catalog.program = "/nonexistent/agentpier-ssh";
  assert.equal(await code(f.execute(f.ownTurn(), "true")), "SSH_HOST_UNAVAILABLE");
  assert.equal(f.audit.filter((e) => e.action === "ssh.executed").length, 0);
  assert.equal(rows(f).length, 0);
});

test("one command per agent runs at a time", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([
    { accessId: hostId, mode: "trusted" },
    { accessId: otherHostId, mode: "trusted" },
  ]);
  const slow = f.execute(f.ownTurn(), "setTimeout(() => {}, 1500)");
  await waitFor(() => f.catalog.connections === 1);
  assert.equal(
    await code(f.execute(f.ownTurn(), "process.exit(0)", otherHostId)),
    "SSH_BUSY",
  );
  assert.equal((await slow).status, "completed");
});

test("exit codes and timeouts are reported as completed runs", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  const failed = await f.execute(f.ownTurn(), "process.exit(3)");
  assert.equal(failed.status, "completed");
  assert.equal(failed.exitCode, 3);
  const slow = await f.execute(f.ownTurn(), "setTimeout(() => {}, 5000)", hostId, {
    timeoutSeconds: 1,
  });
  assert.equal(slow.status, "completed");
  assert.equal(slow.timedOut, true);
});

test("a retried tool call never runs twice", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  const inv = f.ownTurn();
  await f.execute(inv, "process.exit(0)");
  assert.equal(await code(f.execute(inv, "process.exit(0)")), "CONFLICT");
  assert.equal(f.catalog.connections, 1);
});

test("a permanent member uses its own grants in a lead's task", async (t) => {
  const f = await agentSshFixture(t);
  const m = f.member();
  f.grant([{ accessId: hostId, mode: "trusted" }], m.id);
  const inv = f.turn(m.conversationId, {
    kind: "lead-request",
    requestId: "r1",
    leadAssistantId: f.id,
  });
  assert.equal((await f.execute(inv, "process.exit(0)")).status, "completed");
  const [row] = rows(f, m.id);
  assert.equal(row.conversationId, m.conversationId);
  assert.equal(row.payload.originClass, "delegated");
  assert.equal(row.memberName, "Scout");
});

test("a lead's grant never reaches its member and task members get nothing", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  const m = f.member();
  const delegated = { kind: "lead-request", requestId: "r1", leadAssistantId: f.id };
  assert.equal(
    await code(f.execute(f.turn(m.conversationId, delegated), "process.exit(0)")),
    "SSH_NOT_GRANTED",
  );
  const task = f.member({ lifetime: "task", name: "Temp" });
  assert.equal(
    await code(f.execute(f.turn(task.conversationId, delegated), "process.exit(0)")),
    "FORBIDDEN",
  );
});
