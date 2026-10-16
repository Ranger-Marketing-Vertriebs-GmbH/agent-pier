import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import {
  agentSshFixture,
  hostId,
  otherHostId,
  waitFor,
} from "../helpers/agent-ssh-fixture.js";

const codeOf = async (promise) => toolError(await promise.catch((e) => e)).code;

test("a running command stops within 500 ms when its access goes away", async (t) => {
  for (const [label, revoke] of [
    ["host removed", (f) => f.catalog.rows.delete(hostId)],
    ["host re-keyed", (f) => (f.catalog.rows.get(hostId).revision = "r2")],
    ["mode lowered", (f) => f.grant([{ accessId: hostId, mode: "approval" }])],
    [
      "agent archived",
      (f) =>
        f.store.db
          .prepare(
            "UPDATE assistants SET body=json_set(body,'$.archivedAt','2026-10-16T00:00:00.000Z') WHERE id=?",
          )
          .run(f.id),
    ],
    ["turn ended", (_f, inv) => inv.end()],
  ])
    await t.test(label, async (t) => {
      const f = await agentSshFixture(t);
      f.workflows.ssh.intervalMs = 50;
      f.grant([{ accessId: hostId, mode: "trusted" }]);
      const inv = f.ownTurn();
      const call = f.execute(inv, "setTimeout(() => {}, 30000)");
      await waitFor(() => f.catalog.connections === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = Date.now();
      revoke(f, inv);
      assert.equal(await codeOf(call), "SSH_REVOKED");
      assert.ok(Date.now() - started < 500, label);
      const row = f.workflows.store.list(f.id).find((a) => a.payload.trusted);
      assert.equal(row.state, "failed");
      assert.equal(row.result.reason, "revoked");
      assert.ok(
        f.audit.some((e) => e.action === "ssh.executed" && e.details.revoked === true),
      );
    });
});

test("removing a host revokes it from every agent and cancels its open cards", async (t) => {
  const f = await agentSshFixture(t);
  f.workflows.ssh.approvals.pollMs = 20;
  const m = f.member();
  f.grant([
    { accessId: hostId, mode: "approval" },
    { accessId: otherHostId, mode: "trusted" },
  ]);
  f.grant([{ accessId: hostId, mode: "trusted" }], m.id);
  const call = f.execute(f.ownTurn(), "process.exit(0)");
  const action = await waitFor(() =>
    f.workflows.store.list(f.id).find((a) => a.state === "awaiting_approval"),
  );
  const changed = f.workflows.ssh.revokeAccess(hostId);
  assert.deepEqual(changed.sort(), [f.id, m.id].sort());
  assert.deepEqual(f.workflows.access.get(f.id).sshAccesses, [
    { accessId: otherHostId, mode: "trusted" },
  ]);
  assert.deepEqual(f.workflows.access.get(m.id).sshAccesses, []);
  const cancelled = f.workflows.get(action.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.diagnostic, "HOST_REMOVED");
  assert.equal(await codeOf(call), "SSH_REVOKED");
  assert.equal(
    f.audit.filter(
      (e) => e.action === "assistant.updated" && e.details.reason === "host-removed",
    ).length,
    2,
  );
});

test("the hook does nothing once the workflows are closed", async (t) => {
  const f = await agentSshFixture(t);
  f.grant([{ accessId: hostId, mode: "trusted" }]);
  f.services.sshManagement.onAccessChanged = f.workflows.ssh.hook;
  f.workflows.ssh.close();
  assert.equal(f.services.sshManagement.onAccessChanged, null);
  assert.deepEqual(f.workflows.ssh.revokeAccess(hostId), []);
});

test("the startup sweep kills a command a crashed AgentPier left running", async (t) => {
  const f = await agentSshFixture(t);
  const dir = path.join(f.dataDir, "ssh", "agents");
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `${f.id}.lock.sqlite`);
  const module = new URL(
    "../../server/features/ssh/ssh-execution-lock.js",
    import.meta.url,
  ).href;
  // A stand-in for a crashed AgentPier: it holds the agent's lock with a child.
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { spawn } from "node:child_process";
       import { acquireExecutionLock } from ${JSON.stringify(module)};
       const lease = await acquireExecutionLock(${JSON.stringify(lock)});
       const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
       child.unref();
       lease.child(child.pid);
       process.stdout.write(child.pid + "\\n");
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const orphan = Number(
    await new Promise((resolve) =>
      holder.stdout.once("data", (d) => resolve(String(d).trim())),
    ),
  );
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  t.after(() => {
    try {
      process.kill(orphan, "SIGKILL");
    } catch {}
  });
  const alive = () => {
    try {
      process.kill(orphan, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(alive(), true);
  await f.workflows.ssh.start();
  await waitFor(() => !alive(), 2000);
});

test("removing a host keeps the agent's unrelated pending approvals valid", async (t) => {
  const f = await agentSshFixture(t);
  f.workflows.ssh.approvals.pollMs = 20;
  f.grant([{ accessId: hostId, mode: "approval" }]);
  const coding = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Implement feature",
  });
  assert.equal(coding.state, "awaiting_approval");
  const call = f.execute(f.ownTurn(), "process.exit(0)");
  const card = await waitFor(() =>
    f.workflows.store
      .list(f.id)
      .find((a) => a.id !== coding.id && a.state === "awaiting_approval"),
  );
  f.workflows.ssh.revokeAccess(hostId);
  assert.equal(f.workflows.get(card.id).state, "cancelled");
  assert.equal(await codeOf(call), "SSH_REVOKED");
  const pending = f.workflows.get(coding.id);
  await f.workflows.decide(
    pending.id,
    { revision: pending.revision, decision: "approve" },
    { kind: "owner" },
  );
  await f.workflows.tick();
  assert.equal(f.starts.length, 1);
});
