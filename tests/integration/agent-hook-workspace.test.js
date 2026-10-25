import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { leadShareFixture } from "../helpers/lead-share-fixture.js";
import { setup as sftpSetup } from "../helpers/agent-sftp-fixture.js";
import { hostId, otherHostId, sftpHostId } from "../helpers/agent-ssh-fixture.js";
import { AgentHooks } from "../../server/features/assistants/agent-hooks.js";
import { runSession } from "../../server/features/assistants/agent-hook-runs.js";
import {
  effectiveRights,
  hookDefaults,
} from "../../server/features/assistants/agent-hook-rights.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("expected a refusal");
};

/**
 * A stand-in for AgentHooks on a workflow fixture: hooks and running events in
 * memory, and runOrigin as the service resolves it, with the real live ceiling
 * (AgentHooks#ceiling) and effectiveRights, so a right the agent loses mid-run is
 * gone on the next call. `start(agentId, chatId, rights)` returns a running event
 * and `inv(run)` the invocation the tool bridge hands over for one tool call (its
 * `assertCurrent` re-checks the origin like assertHookRecord).
 */
function hookRuns(f) {
  const hooks = new Map();
  const events = new Map();
  const chats = new Map();
  const ceilingOf = (agent) =>
    AgentHooks.prototype.ceiling.call(
      { assistants: f.assistants, routines: { channels: f.service } },
      agent,
    );
  const service = {
    events: {
      byJob: (job) => [...events.values()].find((e) => e.jobId === job) || null,
      get: (id) => events.get(id) || null,
      patch(id, fields) {
        const next = { ...events.get(id), ...fields, id };
        events.set(id, next);
        return next;
      },
    },
    runOrigin(agent, sessionKey) {
      const match = runSession.exec(sessionKey);
      const event = match && service.events.byJob(match[2]);
      if (event?.status !== "running" || event.assistantId !== agent.id) return null;
      const hook = hooks.get(event.hookId);
      const ceiling = ceilingOf(agent);
      return {
        hook,
        event,
        conversation: f.store.getConversation(chats.get(agent.id)),
        effective: effectiveRights(hook.rights, ceiling),
        ceiling,
      };
    },
  };
  f.assistants.routines = { runOrigin: () => null, hooks: service };
  const start = (agentId, chatId, rights = {}) => {
    chats.set(agentId, chatId);
    const hook = {
      id: randomUUID(),
      assistantId: agentId,
      name: "Zabbix",
      rights: { ...hookDefaults, ...rights },
    };
    hooks.set(hook.id, hook);
    const event = {
      id: randomUUID(),
      hookId: hook.id,
      assistantId: agentId,
      jobId: `job-${randomUUID()}`,
      status: "running",
    };
    events.set(event.id, event);
    const agent = f.store.getAssistant(agentId);
    return {
      hook,
      event,
      agent,
      sessionKey: `agent:${agent.runtimeAgentId}:cron:${event.jobId}:run:r1`,
    };
  };
  const inv = (run) => {
    const origin = service.runOrigin(run.agent, run.sessionKey);
    assert.ok(origin, "the event runs");
    return {
      attemptId: null,
      toolCallId: randomUUID(),
      startedAt: Date.now(),
      sessionKey: run.sessionKey,
      hook: origin,
      routine: null,
      continuation: null,
      assertCurrent() {
        const now = service.runOrigin(run.agent, run.sessionKey);
        if (now?.event.id !== origin.event.id)
          throw Object.assign(Error("stale"), { status: 403, key: "invalid" });
      },
    };
  };
  return { start, inv, events: service.events, hooks };
}

async function setup(t) {
  const f = await leadShareFixture(t);
  const runs = hookRuns(f);
  // Home holds both projects for coding (the fixture's runs start on f.project).
  f.workflows.access.save(
    f.lead,
    {
      ...f.policy,
      projectIds: [f.project.id, f.folderProject.id],
      projectFiles: { [f.folderProject.id]: "write" },
    },
    f.workflows.access.get(f.lead).revision,
  );
  const work = (run, input) =>
    f.workflows.invoke(runs.inv(run), { projectId: f.folderProject.id, ...input });
  const coding = {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Look at the alert",
  };
  return { ...f, ...runs, work, coding };
}

test("a hook with Coding starts an approved coding run without a card", async (t) => {
  const f = await setup(t);
  assert.equal(f.workflows.access.get(f.lead).autonomous, false);
  const run = f.start(f.lead, f.channel.conversationId, { coding: true });
  const projected = await f.work(run, f.coding);
  assert.equal(projected.state, "approved");
  const action = f.workflows.store.get(projected.id);
  assert.equal(action.hookId, run.hook.id);
  assert.equal(action.hookEventId, run.event.id);
  assert.equal(action.hook, undefined, "the origin object is never stored");
  assert.deepEqual(action.origin, {
    kind: "hook",
    hookId: run.hook.id,
    eventId: run.event.id,
  });
  assert.match(action.key, new RegExp(`^hook:${run.event.id}:`));
  assert.deepEqual(f.events.get(run.event.id).coding, [action.id]);
  // No approval card anywhere: nothing in the Telegram outbox.
  assert.deepEqual(
    f.service.outbox.all(f.channel.id).filter((e) => e.key.includes(action.id)),
    [],
  );
  await f.workflows.tick();
  assert.equal(f.starts.length, 1);
  assert.equal(f.workflows.store.get(action.id).state, "running");
  // Status and artifacts of that run stay reachable in the same hook run.
  const status = await f.work(run, { action: "coding_status", id: action.id });
  assert.equal(status.run.status, "running");
});

test("without Coding a hook run cannot request coding and never cancels", async (t) => {
  const f = await setup(t);
  const without = f.start(f.lead, f.channel.conversationId, {
    folders: { [f.folderProject.id]: "read" },
  });
  await assert.rejects(f.work(without, f.coding), { status: 403 });
  await assert.rejects(f.work(without, { action: "coding_status", id: "x" }), {
    status: 403,
  });
  assert.equal(f.workflows.store.list(f.lead).length, 0);
  const withCoding = f.start(f.lead, f.channel.conversationId, { coding: true });
  const action = await f.work(withCoding, f.coding);
  await f.workflows.tick();
  await assert.rejects(f.work(withCoding, { action: "coding_cancel", id: action.id }), {
    status: 403,
  });
  assert.equal(f.workflows.store.get(action.id).state, "running");
});

test("hook folders are capped at the hook's level", async (t) => {
  const f = await setup(t);
  // The agent writes both folders; the hook reads one of them.
  f.workflows.access.save(
    f.lead,
    {
      ...f.policy,
      projectIds: [f.folderProject.id],
      projectFiles: { [f.folderProject.id]: "write", [f.project.id]: "write" },
    },
    f.workflows.access.get(f.lead).revision,
  );
  const run = f.start(f.lead, f.channel.conversationId, {
    folders: { [f.folderProject.id]: "read" },
  });
  const read = await f.work(run, { action: "file_read", path: "README.md" });
  assert.equal(read.access, "read");
  assert.equal(read.content, "# Site\n");
  await assert.rejects(
    f.work(run, { action: "file_write", path: "a.md", content: "x" }),
    {
      status: 403,
      key: "projectFolderReadOnly",
    },
  );
  await assert.rejects(f.work(run, { action: "files_list", projectId: f.project.id }), {
    status: 403,
    key: "projectFolderNotGranted",
  });
  assert.equal(fs.existsSync(path.join(f.folder, "a.md")), false);
  // The catalog names only the hook's folder, at the hook's level.
  const { projects } = await f.work(run, { action: "catalog" });
  assert.deepEqual(
    projects.filter((p) => p.folder).map((p) => [p.id, p.folder.access]),
    [[f.folderProject.id, "read"]],
  );
});

test("a folder revoked mid-run refuses the next write", async (t) => {
  const f = await setup(t);
  const run = f.start(f.lead, f.channel.conversationId, {
    folders: { [f.folderProject.id]: "write" },
  });
  const first = await f.work(run, { action: "file_write", path: "a.md", content: "1" });
  assert.equal(first.created, true);
  // The owner lowers the agent's grant to read: the next write is refused.
  f.leadAccess({ [f.folderProject.id]: "read" });
  await assert.rejects(
    f.work(run, { action: "file_write", path: "a.md", content: "2" }),
    {
      status: 403,
      key: "projectFolderReadOnly",
    },
  );
  // Revoked entirely: the hook holds no folder any more, not even for a read.
  f.leadAccess({});
  await assert.rejects(
    f.work(run, { action: "file_write", path: "a.md", content: "3" }),
    {
      status: 403,
    },
  );
  await assert.rejects(f.work(run, { action: "file_read", path: "a.md" }), {
    status: 403,
  });
  assert.equal(fs.readFileSync(path.join(f.folder, "a.md"), "utf8"), "1");
});

test("hook project writes are audited with via hook and the hook id", async (t) => {
  const f = await setup(t);
  const run = f.start(f.lead, f.channel.conversationId, {
    folders: { [f.folderProject.id]: "write" },
  });
  await f.work(run, { action: "file_write", path: "alert.md", content: "disk full" });
  const raw = f.audits.find((e) => e.details?.kind === "project-file");
  assert.equal(raw.resourceId, f.lead);
  assert.equal(raw.projectId, f.folderProject.id);
  // The audit log keeps them through its whitelist (audit-hook-details.js).
  const kept = auditEvent(raw).details;
  assert.equal(kept.kind, "project-file");
  assert.equal(kept.via, "hook");
  assert.equal(kept.hookId, run.hook.id);
  assert.equal(kept.hookEventId, run.event.id);
  assert.equal(kept.filePath, "alert.md");
  assert.equal(kept.fileChange, "create");
  assert.equal(JSON.stringify(kept).includes("disk full"), false);
});

test("project memory and owner-only actions are refused in a hook run", async (t) => {
  const f = await setup(t);
  const run = f.start(f.lead, f.channel.conversationId, {
    coding: true,
    folders: { [f.folderProject.id]: "write" },
  });
  for (const input of [
    { action: "memory_write", title: "T", content: "C" },
    { action: "memory_read", id: "x" },
    { action: "memory_search", query: "q" },
    { action: "actions" },
    { action: "browser_upload_stage", path: "README.md" },
  ])
    await assert.rejects(f.work(run, input), { status: 403 }, input.action);
  assert.equal(f.workflows.store.list(f.lead).length, 0);
});

test("a hook run's rights end when its event settles", async (t) => {
  const f = await setup(t);
  const run = f.start(f.lead, f.channel.conversationId, {
    folders: { [f.folderProject.id]: "write" },
  });
  const inv = f.inv(run);
  f.events.patch(run.event.id, { status: "completed" });
  await assert.rejects(f.workflows.invoke(inv, { action: "catalog" }), { status: 403 });
});

test("a coding request on a lead's share still waits for the owner", async (t) => {
  const f = await setup(t);
  // Scout holds a coding project of its own (so Coding can be ticked) and its
  // lead's standing share of the folder project, even with autonomous starts.
  f.workflows.access.save(
    f.member.assistantId,
    {
      projectIds: [f.project.id],
      pipelineIds: [f.pipeline.id],
      memoryWrite: false,
      autonomous: true,
      publish: false,
    },
    f.workflows.access.get(f.member.assistantId).revision,
  );
  await f.share({ coding: [f.folderProject.id] });
  const run = f.start(f.member.assistantId, f.memberChat.id, { coding: true });
  const shared = await f.work(run, { ...f.coding, projectId: f.folderProject.id });
  assert.equal(shared.state, "awaiting_approval");
  const stored = f.workflows.store.get(shared.id);
  assert.equal(stored.inherited.leadId, f.lead);
  assert.equal(stored.hookEventId, run.event.id);
  // On its own project the same hook starts at once.
  const own = await f.work(run, f.coding);
  assert.equal(own.state, "approved");
  assert.deepEqual(f.events.get(run.event.id).coding, [shared.id, own.id]);
});

// The SFTP fixture: two SSH hosts and an SFTP host, all granted in mode routines.
async function sshSetup(t) {
  const f = await sftpSetup(t);
  f.assistants.config = { ...f.assistants.config, apply: async () => {} };
  const runs = hookRuns(f);
  const modes = (mode = {}) =>
    f.access(
      [hostId, otherHostId, sftpHostId].map((accessId) => ({
        accessId,
        mode: mode[accessId] || "routines",
      })),
    );
  modes();
  const run = runs.start(f.id, f.channel.conversationId, {
    sshHosts: [hostId, sftpHostId],
  });
  const ssh = (input) => f.call(runs.inv(run), input);
  return { ...f, ...runs, run, modes, ssh };
}

test("SSH from a hook runs only on its chosen hosts in mode routines", async (t) => {
  const f = await sshSetup(t);
  const { hosts } = await f.ssh({ action: "hosts" });
  assert.deepEqual(hosts.map((h) => [h.accessId, h.usable]).sort(), [
    [hostId, true],
    [sftpHostId, true],
  ]);
  const ran = await f.ssh({
    action: "execute",
    accessId: hostId,
    command: "console.log('ok')",
  });
  assert.equal(ran.status, "completed");
  assert.equal(ran.exitCode, 0);
  const trusted = f.workflows.store
    .list(f.id)
    .find((a) => a.payload.action === "ssh" && a.payload.trusted);
  assert.equal(trusted.payload.originClass, "hook");
  assert.equal(trusted.origin.kind, "hook");
  const executed = f.audit.find((e) => e.action === "ssh.executed");
  assert.equal(executed.details.originClass, "hook");
  // A host in mode routines the hook did not choose.
  assert.equal(
    await code(f.ssh({ action: "execute", accessId: otherHostId, command: "1" })),
    "SSH_NOT_GRANTED",
  );
  // The chosen host moved to "trusted": refused on the next call of the same run.
  f.modes({ [hostId]: "trusted" });
  assert.equal(
    await code(f.ssh({ action: "execute", accessId: hostId, command: "1" })),
    "SSH_NOT_GRANTED",
  );
  const denied = f.audit.filter((e) => e.action === "ssh.denied");
  assert.equal(denied.length, 2);
  assert.ok(denied.every((e) => e.details.originClass === "hook"));
  assert.deepEqual(
    (await f.ssh({ action: "hosts" })).hosts.map((h) => h.accessId),
    [sftpHostId],
  );
});

test("SFTP from a hook follows the same host choice and never deletes", async (t) => {
  const f = await sshSetup(t);
  f.file(f.server.root, "www/index.html", "<h1>hi</h1>");
  const listed = await f.ssh({
    action: "list",
    accessId: sftpHostId,
    remotePath: "/www",
  });
  assert.deepEqual(
    listed.entries.map((e) => e.name),
    ["index.html"],
  );
  assert.equal(
    await code(f.ssh({ action: "delete", accessId: sftpHostId, remotePath: "/www" })),
    "SFTP_ROUTINE_DELETE",
  );
  assert.ok(fs.existsSync(path.join(f.server.root, "www/index.html")));
  // A download would write the agent's workspace: never from a hook.
  assert.equal(
    await code(
      f.ssh({
        action: "download",
        accessId: sftpHostId,
        remotePath: "/www",
        localPath: "backup",
      }),
    ),
    "SFTP_WORKSPACE_REFUSED",
  );
  assert.equal(fs.existsSync(path.join(f.workspace, "backup")), false);
  // Off the hook's hosts (the owner unticked it): refused like SSH.
  f.hooks.get(f.run.hook.id).rights.sshHosts = [hostId];
  assert.equal(
    await code(f.ssh({ action: "list", accessId: sftpHostId, remotePath: "/www" })),
    "SSH_NOT_GRANTED",
  );
  // Moved to "trusted" while chosen: refused as well.
  f.hooks.get(f.run.hook.id).rights.sshHosts = [sftpHostId];
  f.modes({ [sftpHostId]: "trusted" });
  assert.equal(
    await code(f.ssh({ action: "list", accessId: sftpHostId, remotePath: "/www" })),
    "SSH_NOT_GRANTED",
  );
});
