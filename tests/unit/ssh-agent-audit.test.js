import assert from "node:assert/strict";
import test from "node:test";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { createAgentAudit } from "../../server/features/ssh/ssh-agent-audit.js";

const sessionId = "session-1";
const projectId = "project-1";
const hostA = { accessId: "access-a", name: "Proxmox 2", keyId: "k", legacy: false };
const hostB = { accessId: "access-b", name: "Backup", keyId: "k", legacy: false };

function fakeClock() {
  let time = 1_000_000;
  const timers = new Map();
  let next = 1;
  return {
    now: () => time,
    setTimer(callback, ms) {
      const id = next++;
      timers.set(id, { at: time + ms, callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    tick(ms) {
      time += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > time || !timers.has(id)) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

function setup() {
  const clock = fakeClock();
  const rows = [];
  const audit = createAgentAudit({
    append: (event) => rows.push(event),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, rows, audit };
}

const connectedA = { sessionId, projectId, host: hostA };

test("first connection writes at once, later ones are counted per window", () => {
  const { clock, rows, audit } = setup();
  audit.connected(connectedA);
  audit.connected(connectedA);
  audit.connected(connectedA);
  assert.equal(rows.length, 1);
  clock.tick(60000);
  assert.deepEqual(
    rows.map((r) => [r.action, r.details.count]),
    [
      ["ssh.connected", 1],
      ["ssh.connected", 2],
    ],
  );
  assert.deepEqual(rows[0], {
    action: "ssh.connected",
    resourceType: "ssh",
    resourceId: "access-a",
    sessionId,
    projectId,
    source: "mcp",
    outcome: "success",
    details: { accessId: "access-a", hostName: "Proxmox 2", count: 1 },
  });
  // After the window a new signature is written at once again.
  audit.connected(connectedA);
  assert.equal(rows.length, 3);
  assert.equal(rows[2].details.count, 1);
});

test("a window without further signatures writes nothing when it ends", () => {
  const { clock, rows, audit } = setup();
  audit.connected(connectedA);
  clock.tick(60000);
  assert.equal(rows.length, 1);
  assert.equal(clock.pending, 0);
});

test("windows are kept per session and host", () => {
  const { rows, audit } = setup();
  audit.connected(connectedA);
  audit.connected({ sessionId, projectId, host: hostB });
  audit.connected({ sessionId: "session-2", projectId, host: hostA });
  assert.deepEqual(
    rows.map((r) => [r.sessionId, r.resourceId]),
    [
      [sessionId, "access-a"],
      [sessionId, "access-b"],
      ["session-2", "access-a"],
    ],
  );
});

test("denials are written at most once per code and window", () => {
  const { clock, rows, audit } = setup();
  audit.denied({ sessionId, projectId, code: "SSH_AGENT_UNBOUND" });
  clock.tick(10000);
  audit.denied({ sessionId, projectId, code: "SSH_AGENT_UNBOUND" });
  audit.denied({ sessionId, projectId, code: "SSH_AGENT_FORWARDING" });
  assert.deepEqual(rows, [
    {
      action: "ssh.denied",
      resourceType: "ssh",
      sessionId,
      projectId,
      source: "mcp",
      outcome: "failure",
      details: { code: "SSH_AGENT_UNBOUND" },
    },
    {
      action: "ssh.denied",
      resourceType: "ssh",
      sessionId,
      projectId,
      source: "mcp",
      outcome: "failure",
      details: { code: "SSH_AGENT_FORWARDING" },
    },
  ]);
  clock.tick(50000);
  audit.denied({ sessionId, projectId, code: "SSH_AGENT_UNBOUND" });
  assert.equal(rows.length, 3);
  audit.denied({ sessionId: "session-2", projectId, code: "SSH_AGENT_FORWARDING" });
  assert.equal(rows.length, 4);
});

test("flush writes pending counts on stop and forgets the session", () => {
  const { clock, rows, audit } = setup();
  audit.connected(connectedA);
  audit.connected(connectedA);
  audit.connected({ sessionId: "session-2", projectId, host: hostA });
  audit.connected({ sessionId: "session-2", projectId, host: hostA });
  audit.denied({ sessionId, projectId, code: "SSH_AGENT_UNBOUND" });
  audit.flush(sessionId);
  assert.deepEqual(
    rows.map((r) => [r.sessionId, r.action, r.details.count ?? r.details.code]),
    [
      [sessionId, "ssh.connected", 1],
      ["session-2", "ssh.connected", 1],
      [sessionId, "ssh.denied", "SSH_AGENT_UNBOUND"],
      [sessionId, "ssh.connected", 1],
    ],
  );
  // The other session's window still runs; the flushed session starts fresh.
  assert.equal(clock.pending, 1);
  audit.denied({ sessionId, projectId, code: "SSH_AGENT_UNBOUND" });
  assert.equal(rows.length, 5);
  clock.tick(60000);
  assert.deepEqual(rows.at(-1).details, {
    accessId: "access-a",
    hostName: "Proxmox 2",
    count: 1,
  });
  assert.equal(rows.at(-1).sessionId, "session-2");
});

test("a row without a project omits projectId", () => {
  const { rows, audit } = setup();
  audit.connected({ sessionId, host: hostA });
  audit.denied({ sessionId, code: "SSH_AGENT_NOT_GRANTED" });
  assert.equal("projectId" in rows[0], false);
  assert.equal("projectId" in rows[1], false);
});

test("a failing append never throws into the agent", () => {
  const clock = fakeClock();
  const audit = createAgentAudit({
    append: () => {
      throw new Error("store full");
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  audit.connected(connectedA);
  audit.connected(connectedA);
  audit.denied({ sessionId, code: "SSH_AGENT_UNBOUND" });
  clock.tick(60000);
  audit.flush(sessionId);
});

test("rows pass the audit schema unchanged", () => {
  const { clock, rows, audit } = setup();
  audit.connected(connectedA);
  audit.connected(connectedA);
  clock.tick(60000);
  for (const code of [
    "SSH_AGENT_UNBOUND",
    "SSH_AGENT_FORWARDING",
    "SSH_AGENT_NOT_GRANTED",
    "SSH_AGENT_LEGACY",
    "SSH_AGENT_KEY_UNSUPPORTED",
  ])
    audit.denied({ sessionId, projectId, code });
  for (const row of rows) assert.deepEqual(auditEvent(row), row);
});

test("rows carry no key material or signed data", () => {
  const { clock, rows, audit } = setup();
  const host = {
    ...hostA,
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample",
    hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostKey",
    keyBlob: Buffer.alloc(51, 1),
    hostKeyBlob: Buffer.alloc(51, 2),
    username: "deploy",
  };
  audit.connected({ sessionId, projectId, host });
  audit.connected({ sessionId, projectId, host });
  clock.tick(60000);
  audit.denied({ sessionId, projectId, code: "SSH_AGENT_UNBOUND", data: "AAAA" });
  assert.doesNotMatch(
    JSON.stringify(rows),
    /AAAA|BEGIN|deploy|sessionId":"[A-Za-z0-9+/=]{40,}/,
  );
  for (const row of rows)
    assert.deepEqual(
      Object.keys(row.details).sort(),
      row.details.code ? ["code"] : ["accessId", "count", "hostName"],
    );
});

const agentOwner = { kind: "agent", id: "a1" };

test("an agent row names the agent, not a session, and keeps the access as resource", () => {
  const { rows, audit } = setup();
  audit.connected({ owner: agentOwner, host: hostA });
  assert.deepEqual(rows[0], {
    action: "ssh.connected",
    resourceType: "ssh",
    resourceId: hostA.accessId,
    source: "system",
    outcome: "success",
    details: {
      assistantId: "a1",
      accessId: hostA.accessId,
      hostName: hostA.name,
      count: 1,
    },
  });
  audit.denied({ owner: agentOwner, code: "SSH_AGENT_NOT_GRANTED" });
  assert.equal(rows[1].sessionId, undefined);
  assert.equal(rows[1].source, "system");
  assert.deepEqual(rows[1].details, { assistantId: "a1", code: "SSH_AGENT_NOT_GRANTED" });
  for (const row of rows) assert.deepEqual(auditEvent(row), row);
});

test("a session owner writes the same rows as the sessionId form", () => {
  const legacy = setup();
  const owned = setup();
  legacy.audit.connected(connectedA);
  owned.audit.connected({
    owner: { kind: "session", id: sessionId },
    projectId,
    host: hostA,
  });
  legacy.audit.denied({ sessionId, projectId, code: "SSH_AGENT_UNBOUND" });
  owned.audit.denied({
    owner: { kind: "session", id: sessionId },
    projectId,
    code: "SSH_AGENT_UNBOUND",
  });
  assert.deepEqual(owned.rows, legacy.rows);
  // Both forms share one window: a sessionId call is counted in the owner's window.
  owned.audit.connected(connectedA);
  assert.equal(owned.rows.length, 2);
  owned.audit.flush(`session:${sessionId}`);
  assert.equal(owned.rows.length, 3);
  assert.equal(owned.rows[2].details.count, 1);
});

test("windows of a session and an agent with the same id stay apart", () => {
  const { clock, rows, audit } = setup();
  audit.connected({ owner: { kind: "session", id: "x" }, host: hostA });
  audit.connected({ owner: { kind: "agent", id: "x" }, host: hostA });
  assert.equal(rows.length, 2);
  audit.connected({ owner: { kind: "session", id: "x" }, host: hostA });
  audit.denied({ owner: { kind: "session", id: "x" }, code: "SSH_AGENT_UNBOUND" });
  audit.denied({ owner: { kind: "agent", id: "x" }, code: "SSH_AGENT_UNBOUND" });
  assert.equal(rows.length, 4);
  audit.flush("agent:x");
  // Nothing was pending for the agent; the session's window and denial stay open.
  assert.equal(rows.length, 4);
  assert.equal(clock.pending, 1);
  audit.denied({ owner: { kind: "session", id: "x" }, code: "SSH_AGENT_UNBOUND" });
  assert.equal(rows.length, 4);
  audit.denied({ owner: { kind: "agent", id: "x" }, code: "SSH_AGENT_UNBOUND" });
  assert.equal(rows.length, 5);
  audit.flush("x");
  assert.deepEqual(
    [rows.length, rows[5].sessionId, rows[5].details.count, clock.pending],
    [6, "x", 1, 0],
  );
});
