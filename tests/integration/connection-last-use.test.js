import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import {
  sshLastUse,
  sshLastUseCovers,
  sshUseActions,
} from "../../server/features/accounts/connection-last-use.js";

const lab = "11111111-1111-4111-8111-111111111111";
const files = "33333333-3333-4333-8333-333333333333";

test("last use is the newest audited SSH command or SFTP transfer per host", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-last-use-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-20T10:00:00.000Z");
  const audit = new AuditStore({ dataDir, clock: { now: () => now } });
  t.after(() => audit.close());
  const append = (action, resourceId, outcome = "success") => {
    audit.append({ action, resourceType: "ssh", resourceId, source: "system", outcome });
    now += 60_000;
  };
  append("ssh.executed", lab);
  append("ssh.executed", lab);
  append("sftp.failed", files, "failure");
  // Neither a test nor a creation is a use.
  append("ssh.tested", lab);
  append("ssh.created", files);
  const uses = sshLastUse(audit);
  assert.deepEqual(Object.fromEntries(uses), {
    [lab]: "2026-10-20T10:01:00.000Z",
    [files]: "2026-10-20T10:02:00.000Z",
  });
  assert.equal(sshLastUse(null), null);
  assert.equal(
    sshLastUse({
      latestByResource: () => {
        throw new Error("closed");
      },
    }),
    null,
  );
});

test("hosts used through a session's SSH agent count as last use", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-last-use-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = Date.parse("2026-10-20T10:00:00.000Z");
  const audit = new AuditStore({ dataDir, clock: { now: () => now } });
  t.after(() => audit.close());
  assert.ok(sshUseActions.includes("ssh.connected"));
  assert.ok(sshLastUseCovers.includes("sessionSsh"));
  audit.append({
    action: "ssh.connected",
    resourceType: "ssh",
    resourceId: lab,
    sessionId: "session-1",
    source: "mcp",
    outcome: "success",
    details: { accessId: lab, hostName: "proxmox 2", count: 3 },
  });
  now += 60_000;
  // A refusal names no host and is no use.
  audit.append({
    action: "ssh.denied",
    resourceType: "ssh",
    sessionId: "session-1",
    source: "mcp",
    outcome: "failure",
    details: { code: "SSH_AGENT_UNBOUND" },
  });
  assert.deepEqual(Object.fromEntries(sshLastUse(audit)), {
    [lab]: "2026-10-20T10:00:00.000Z",
  });
});

test("hosts used through an agent's plain ssh count as last use", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-last-use-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const now = Date.parse("2026-10-20T10:00:00.000Z");
  const audit = new AuditStore({ dataDir, clock: { now: () => now } });
  t.after(() => audit.close());
  assert.ok(sshLastUseCovers.includes("agentPlainSsh"));
  // As the agent SSH agents write it (ssh-agent-audit.js, owner kind "agent").
  audit.append({
    action: "ssh.connected",
    resourceType: "ssh",
    resourceId: files,
    source: "system",
    outcome: "success",
    details: { assistantId: "agent-1", accessId: files, hostName: "files", count: 1 },
  });
  assert.deepEqual(Object.fromEntries(sshLastUse(audit)), {
    [files]: "2026-10-20T10:00:00.000Z",
  });
});
