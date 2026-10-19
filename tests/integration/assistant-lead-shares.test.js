import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { leadShareFixture as setup } from "../helpers/lead-share-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

const code = (key) => (error) => toolError(error).code === key;
const shareAudits = (f) => f.audits.filter((e) => e.details?.kind === "lead-share");

test("a lead shares folders and coding with its permanent member within its own level", async (t) => {
  const f = await setup(t);
  const owner = await f.turn(f.memberChat.id);
  // Without a share the member has no access of its own.
  await assert.rejects(
    f.call(owner, { action: "file_read", path: "README.md" }),
    code("PROJECT_NOT_GRANTED"),
  );
  const result = await f.share({
    grants: { projects: { [f.folderProject.id]: "write" } },
    coding: [f.folderProject.id],
    mcpServers: ["render"],
  });
  assert.deepEqual(result, {
    status: "shared",
    memberId: f.member.id,
    projects: [f.folderProject.id],
    coding: [f.folderProject.id],
    mcpServers: 1,
  });
  assert.equal(
    (
      await f.call(await f.turn(f.memberChat.id), {
        action: "file_read",
        path: "README.md",
      })
    ).access,
    "write",
  );
  // Stored apart from the member's own access, with who granted it and when.
  assert.deepEqual(f.workflows.access.get(f.member.assistantId).projectIds, []);
  const [row] = f.shares.rows(f.member.assistantId);
  assert.equal(row.leadId, f.lead);
  assert.equal(row.grantedBy, "lead");
  assert.ok(Date.parse(row.grantedAt));
  const audit = shareAudits(f).at(-1);
  assert.equal(audit.details.change, "grant");
  assert.equal(audit.details.leadAssistantId, f.lead);
  assert.deepEqual(audit.details.mcpServerIds, ["s1"]);
  assert.deepEqual(audit.details.projects, [
    { projectId: f.folderProject.id, coding: true, folder: "write" },
  ]);
  // The member's chat and the lead's get the grant note.
  const notes = f.workflows.store.list(f.member.assistantId);
  assert.equal(notes.at(-1).payload.action, "member_grant");
  assert.deepEqual(notes.at(-1).payload.granted, ["projects", "coding"]);
});

test("a lead can share nothing above what it holds, nor anything but access", async (t) => {
  const f = await setup(t);
  f.leadAccess({ [f.folderProject.id]: "read" });
  await assert.rejects(
    f.share({ grants: { projects: { [f.folderProject.id]: "write" } } }),
    { key: "teamGrantNotHeld" },
  );
  await assert.rejects(f.share({ coding: ["elsewhere"] }), { key: "teamGrantNotHeld" });
  await assert.rejects(f.share({ mcpServers: ["unknown"] }), {
    key: "teamMcpServerNotBound",
  });
  await assert.rejects(f.share({ grants: { webSearch: true } }), {
    key: "teamShareAccessOnly",
  });
  assert.equal(
    toolError({ key: "teamShareAccessOnly", status: 409 }).code,
    "PERMANENT_ACCESS_ONLY",
  );
  assert.deepEqual(f.shares.rows(), []);
});

test("a share follows the lead live and ends when the lead loses it", async (t) => {
  const f = await setup(t);
  await f.share({ grants: { projects: { [f.folderProject.id]: "write" } } });
  const write = async () =>
    f.call(await f.turn(f.memberChat.id), {
      action: "file_write",
      path: "notes.md",
      content: "x",
    });
  assert.equal((await write()).created, true);
  // The lead drops to read: the member's next call is read-only.
  f.leadAccess({ [f.folderProject.id]: "read" });
  await assert.rejects(write(), code("PROJECT_READ_ONLY"));
  assert.equal(f.shares.list()[0].live.folder, "read");
  // The lead loses the project: nothing is left, and the share is removed.
  f.leadAccess({});
  await assert.rejects(write(), code("PROJECT_NOT_GRANTED"));
  assert.equal(f.shares.prune(), false);
  assert.deepEqual(f.shares.rows(), []);
  const revoked = shareAudits(f).at(-1);
  assert.equal(revoked.details.change, "revoke");
  assert.equal(revoked.details.reason, "lead-lost");
});

test("shares end when member or lead is archived", async (t) => {
  for (const who of ["member", "lead"]) {
    const f = await setup(t);
    await f.share({ grants: { projects: { [f.folderProject.id]: "read" } } });
    if (who === "member")
      f.teams.archive(f.member.id, f.teams.member(f.member.id).revision);
    else {
      const a = f.store.getAssistant(f.lead);
      const next = {
        ...a,
        archivedAt: new Date().toISOString(),
        revision: a.revision + 1,
      };
      f.store.db
        .prepare("UPDATE assistants SET body=?,revision=? WHERE id=?")
        .run(JSON.stringify(next), next.revision, a.id);
    }
    assert.deepEqual(f.shares.folders(f.member.assistantId), {}, who);
    f.shares.prune();
    assert.deepEqual(f.shares.rows(), [], who);
    assert.equal(shareAudits(f).at(-1).details.reason, `${who}-archived`, who);
  }
});

test("a lead's task uses only what the lead shares, and writes at the shared level", async (t) => {
  const f = await setup(t);
  // The member's own owner-granted folder does not reach a task of its lead.
  f.workflows.access.save(
    f.member.assistantId,
    {
      ...f.policy,
      projectIds: [f.folderProject.id],
      projectFiles: { [f.folderProject.id]: "write" },
    },
    f.workflows.access.get(f.member.assistantId).revision,
  );
  const readOnly = await f.task();
  await assert.rejects(
    f.call(readOnly.inv, { action: "files_list" }),
    code("PROJECT_NOT_GRANTED"),
  );
  // A read share reads only, also in a task that may not write.
  await f.share({ grants: { projects: { [f.folderProject.id]: "read" } } });
  await assert.rejects(
    f.call(readOnly.inv, { action: "file_write", path: "x.md", content: "x" }),
    code("PROJECT_READ_ONLY"),
  );
  // A standing write share is the lead's authorization: it writes in every task of
  // that lead, also one without the owner's request (writeAllowed false).
  await f.share({ grants: { projects: { [f.folderProject.id]: "write" } } });
  assert.equal(
    (await f.call(readOnly.inv, { action: "file_read", path: "README.md" })).access,
    "write",
  );
  assert.equal(
    (await f.call(readOnly.inv, { action: "file_write", path: "x.md", content: "x" }))
      .created,
    true,
  );
  const shared = f.audits.findLast((e) => e.details?.kind === "project-file");
  assert.equal(shared.details.via, "lead-share");
  assert.equal(shared.details.leadRequestId, readOnly.id);
  assert.equal(shared.details.leadAssistantId, f.lead);
  // The lead's own level caps it live: down to read, the share no longer writes.
  f.leadAccess({ [f.folderProject.id]: "read" });
  await assert.rejects(
    f.call(readOnly.inv, { action: "file_write", path: "y.md", content: "y" }),
    code("PROJECT_READ_ONLY"),
  );
  f.leadAccess({ [f.folderProject.id]: "write" });
  // Memory and other own actions stay out of a lead's task.
  await assert.rejects(
    f.call(readOnly.inv, { action: "memory_search" }),
    code("FORBIDDEN"),
  );
  f.teams.write(f.teams.get(readOnly.id), { phase: "completed" });
  const proven = await f.task({
    ownerProof: { quote: "Scout, render it", sentence: 0 },
    writeAllowed: true,
  });
  const written = await f.call(proven.inv, {
    action: "file_write",
    path: "render.md",
    content: "done",
  });
  assert.equal(written.created, true);
  assert.equal(fs.readFileSync(path.join(f.folder, "render.md"), "utf8"), "done");
  const audit = f.audits.findLast((e) => e.details?.kind === "project-file");
  assert.equal(audit.resourceId, f.member.assistantId);
  assert.equal(audit.details.leadAssistantId, f.lead);
  assert.equal(audit.details.leadRequestId, proven.id);
  f.teams.write(f.teams.get(proven.id), { phase: "completed" });
  // An autonomous task may write too; a cancelled one never.
  const autonomous = await f.task({ autonomous: true, writeAllowed: true });
  assert.equal(
    (await f.call(autonomous.inv, { action: "file_write", path: "a.md", content: "a" }))
      .created,
    true,
  );
  f.teams.write(f.teams.get(autonomous.id), { cancelRequested: true });
  await assert.rejects(
    f.call(autonomous.inv, { action: "files_list" }),
    code("FORBIDDEN"),
  );
});

test("a task's own share works only in that task and ends with it", async (t) => {
  const f = await setup(t);
  const { taskShare, applyTaskShare } =
    await import("../../server/features/assistants/lead-share-input.js");
  const lead = f.store.getAssistant(f.lead);
  const share = taskShare(f.workflows, lead, f.teams.member(f.member.id), {
    projects: { [f.folderProject.id]: "read" },
    mcpServers: ["render"],
  });
  const one = await f.task();
  applyTaskShare(share, f.teams.get(one.id), one.inv);
  assert.equal((await f.call(one.inv, { action: "files_list" })).access, "read");
  assert.deepEqual(f.shares.mcpBindings(), { [f.member.assistantId]: ["s1"] });
  // Not in the owner's own turns with the member.
  await assert.rejects(
    f.call(await f.turn(f.memberChat.id), { action: "files_list" }),
    code("PROJECT_NOT_GRANTED"),
  );
  f.teams.write(f.teams.get(one.id), { phase: "completed" });
  assert.deepEqual(f.shares.mcpBindings(), {});
  assert.equal(f.shares.prune(), true, "an MCP share went");
  assert.deepEqual(f.shares.rows(), []);
  assert.equal(shareAudits(f).at(-1).details.reason, "task-ended");
  assert.throws(
    () =>
      taskShare(f.workflows, lead, f.teams.member(f.member.id), {
        projects: { other: "read" },
      }),
    { key: "teamGrantNotHeld" },
  );
});

test("coding on a shared project always waits for the owner and runs on the lead's grant", async (t) => {
  const f = await setup(t);
  // Even a lead with standing permission: the member's request waits.
  f.leadAccess({ [f.folderProject.id]: "write" }, { autonomous: true });
  const start = f.services.pipelines.start;
  f.services.pipelines.start = async (input, options) =>
    Object.assign(await start(input, options), { projectId: input.projectId });
  await f.share({ coding: [f.folderProject.id] });
  const { inv } = await f.task();
  const catalog = await f.call(inv, { action: "catalog" });
  assert.deepEqual(
    catalog.projects.map((p) => [p.id, p.sharedBy]),
    [[f.folderProject.id, f.lead]],
  );
  assert.deepEqual(
    catalog.pipelines.map((p) => p.id),
    [f.pipeline.id],
  );
  const action = await f.call(inv, {
    action: "coding_start",
    pipelineId: f.pipeline.id,
    task: "Render the site",
  });
  assert.equal(action.state, "awaiting_approval");
  const stored = f.workflows.store.get(action.id);
  assert.equal(stored.assistantId, f.member.assistantId);
  assert.equal(stored.inherited.leadId, f.lead);
  // Shown in the lead's chat too, as a member's request in a task it delegated.
  assert.equal(stored.leadAssistantId, f.lead);
  assert.ok(
    f.workflows.list(f.lead, { delegated: true }).actions.some((a) => a.id === action.id),
  );
  await f.workflows.decide(
    action.id,
    { decision: "approve", revision: stored.revision },
    { kind: "owner" },
  );
  await f.workflows.advanceAction(f.workflows.store.get(action.id));
  assert.equal(f.workflows.store.get(action.id).state, "running");
  assert.equal(f.starts.length, 1);
  // The member reaches its own run.
  const status = await f.call(inv, { action: "coding_status", id: action.id });
  assert.equal(status.run.status, "running");
  // The run is the member's own, started with its client id on the lead's project.
  assert.ok(f.workflows.coding.receipt(f.workflows.store.get(action.id)));
});

test("the owner removes a share; requests resting on it fail closed", async (t) => {
  const f = await setup(t);
  await f.share({ coding: [f.folderProject.id], mcpServers: ["render"] });
  const { inv } = await f.task();
  const action = await f.call(inv, {
    action: "coding_start",
    pipelineId: f.pipeline.id,
    task: "Render",
  });
  const listed = f.shares.list((s) => s.memberAssistantId === f.member.assistantId);
  assert.deepEqual(
    listed.map((s) => [s.kind, s.leadName, s.memberName]),
    [
      ["project", "Home", "Scout"],
      ["mcp", "Home", "Scout"],
    ],
  );
  const project = listed.find((s) => s.kind === "project");
  f.shares.remove(project.id);
  assert.equal(f.workflows.store.get(action.id).state, "failed");
  assert.equal(f.workflows.store.get(action.id).diagnostic, "GRANT_REVOKED");
  const audit = shareAudits(f).at(-1);
  assert.equal(audit.details.by, "owner");
  assert.equal(audit.source, "user");
  const mcp = listed.find((s) => s.kind === "mcp");
  f.assistants.mcp.pending = false;
  f.shares.remove(mcp.id);
  assert.equal(f.assistants.mcp.pending, true, "the running Gateway follows");
  assert.deepEqual(f.shares.mcpBindings(), {});
  assert.throws(() => f.shares.remove(mcp.id), { status: 404 });
});

test("a lead's turn on a member's result still never changes anything", async (t) => {
  const f = await setup(t);
  f.leadAccess({ [f.folderProject.id]: "write" });
  const { id } = await f.task({ phase: "completed" });
  const inv = await f.turn(f.channel.conversationId, {
    kind: "member-result",
    requestId: id,
  });
  await assert.rejects(
    f.call(inv, { action: "file_write", path: "x.md", content: "x" }),
    code("FORBIDDEN"),
  );
  assert.deepEqual(f.marked, [id]);
  assert.equal(f.teams.get(id).resultWriteRefused, true);
});

test("a shared MCP server compiles for the member while the lead holds it", async (t) => {
  const f = await setup(t);
  const { McpChanges } = await import("../../server/features/assistants/mcp-changes.js");
  const changes = new McpChanges({ assistants: f.assistants, servers: f.mcpStore });
  await f.share({ mcpServers: ["render", "files"] });
  assert.deepEqual(changes.inherited(), { [f.member.assistantId]: ["s1", "s2"] });
  assert.equal(f.assistants.mcp.pending, true, "applied with the next MCP apply");
  // The overview names each member using a server through its lead.
  const [render] = changes.sharedViews([{ id: "s1", name: "render" }]);
  assert.deepEqual(
    render.shared.map((s) => [s.agentName, s.leadName, s.bound]),
    [["Scout", "Home", true]],
  );
  // An agent with its own Telegram bot for other people never runs a stdio server.
  f.assistants.mcp.telegramSenders = { connected: (id) => id === f.member.assistantId };
  assert.deepEqual(changes.inherited(), { [f.member.assistantId]: ["s1"] });
  await assert.rejects(f.share({ mcpServers: ["files"] }), { key: "teamGrantNotHeld" });
  f.assistants.mcp.telegramSenders = null;
  // The lead loses a binding: the member loses it at once, and the share ends.
  f.bindings.set(f.lead, ["s2"]);
  assert.deepEqual(changes.inherited(), { [f.member.assistantId]: ["s2"] });
  assert.equal(f.shares.prune(), true);
  assert.deepEqual(
    f.shares.rows().map((r) => r.serverId),
    ["s2"],
  );
  // A lead takes a share back itself.
  const revoked = await f.share({ mcpServers: ["files"], revoke: true });
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(changes.inherited(), {});
});
