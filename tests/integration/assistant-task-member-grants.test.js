import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { taskMemberGrantFixture as setup } from "../helpers/task-member-grant-fixture.js";
import { leadShareFixture } from "../helpers/lead-share-fixture.js";
import { actionNotes } from "../../server/features/assistants/assistant-action-notifications.js";
import { projectAgents } from "../../server/features/assistants/project-agent-access.js";
import { McpChanges } from "../../server/features/assistants/mcp-changes.js";
import { assistantLeadShareRoutes } from "../../server/http/routes/assistant-lead-shares.js";
import { registerResponses } from "../../server/http/responses.js";

const grantAudits = (f) => f.audits.filter((e) => e.details?.kind === "member-grant");
const listed = async (f, query = `memberId=${f.member.assistantId}`) =>
  (await f.http("GET", `/api/assistant-lead-shares?${query}`)).body;
const revoke = (f, id) =>
  f.http("DELETE", `/api/assistant-lead-shares/${encodeURIComponent(id)}`);
const pendingCards = (f) =>
  f.workflows
    .list(f.lead)
    .actions.filter((a) => a.payload.action === "member_grant" && a.payload.approval);

test("the overview lists a task member's inherited grants at the level they count now", async (t) => {
  const f = await setup(t);
  const body = await listed(f);
  assert.deepEqual(body.shares, [], "no permanent shares for a task member");
  const byKind = (kind) => body.memberGrants.filter((g) => g.kind === kind);
  const [folder] = byKind("project");
  assert.equal(folder.projectId, f.folderProject.id);
  assert.equal(folder.folder, "write");
  assert.deepEqual(folder.live, { coding: false, folder: "write" });
  assert.equal(folder.temporary, true);
  assert.equal(folder.revocable, true);
  assert.equal(folder.leadName, "Home");
  assert.equal(folder.memberName, "Scout");
  assert.equal(folder.id, `task:${f.member.id}:project:${f.folderProject.id}`);
  // Coding runs through the lead's grant: listed, never revocable on its own.
  assert.deepEqual(
    byKind("coding").map((g) => [g.projectId, g.revocable, g.live.coding]),
    [[f.folderProject.id, false, true]],
  );
  assert.deepEqual(
    byKind("mcp").map((g) => [g.serverName, g.live.bound]),
    [["render", true]],
  );
  assert.deepEqual(
    byKind("shell").map((g) => [g.shell, g.live.shell]),
    [["approval", "approval"]],
  );
  assert.deepEqual(
    byKind("ssh").map((g) => g.live.ssh),
    [true],
  );
  // The lead drops to read and loses the server: the member's grants are capped
  // live and the server counts for nothing, but stays listed for the owner.
  f.leadAccess({ [f.folderProject.id]: "read" });
  f.bindings.set(f.lead, ["s2"]);
  const capped = await listed(f);
  const now = (kind) => capped.memberGrants.find((g) => g.kind === kind);
  assert.equal(now("project").folder, "write");
  assert.equal(now("project").live.folder, "read");
  assert.equal(now("mcp").live.bound, false);
  f.leadAccess({});
  const lost = await listed(f);
  assert.equal(lost.memberGrants.find((g) => g.kind === "project").live.folder, "none");
  assert.equal(lost.memberGrants.filter((g) => g.kind === "coding").length, 0);
  // Filters: by project and by server, and nothing for another member.
  f.leadAccess({ [f.folderProject.id]: "write" });
  assert.equal(
    (await listed(f, `projectId=${f.folderProject.id}`)).memberGrants.length,
    2,
  );
  assert.equal((await listed(f, "serverId=s1")).memberGrants.length, 1);
  assert.equal((await listed(f, "memberId=nobody")).memberGrants.length, 0);
});

test("the owner revokes a folder like the lead would, audited with the owner as actor", async (t) => {
  const f = await setup(t);
  const id = `task:${f.member.id}:project:${f.folderProject.id}`;
  const response = await revoke(f, id);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { removed: id, kind: "project", pending: false });
  assert.equal(f.teams.member(f.member.id).grants.projects, undefined);
  assert.deepEqual(f.agent().inherited.projects, {});
  const entry = f.teams.member(f.member.id).grantLog.at(-1);
  assert.equal(entry.by, "owner");
  assert.equal(entry.direct, true);
  assert.deepEqual(entry.revoked, ["projects"]);
  const audit = grantAudits(f).at(-1);
  assert.equal(audit.source, "user");
  assert.equal(audit.details.by, "owner");
  assert.equal(audit.details.change, "revoke");
  assert.deepEqual(audit.details.grants, ["projects"]);
  assert.equal(audit.details.leadAssistantId, f.lead);
  // Noted in the member's chat and the lead's, as the owner's revocation.
  for (const [owner, chat] of [
    [f.member.assistantId, f.memberChat.id],
    [f.lead, f.channel.conversationId],
  ]) {
    const [note] = actionNotes(f.workflows.store.list(owner), chat);
    assert.equal(note.by, "owner");
    assert.deepEqual(note.revoked, ["projects"]);
  }
  assert.equal(
    (await listed(f)).memberGrants.some((g) => g.kind === "project"),
    false,
  );
  assert.equal((await revoke(f, id)).status, 404, "gone once revoked");
});

test("revoking an MCP server applies to the running Gateway at once", async (t) => {
  const f = await setup(t);
  // A server the lead granted later is listed as well.
  await f.call({ mcpServers: ["files"] });
  assert.deepEqual(f.bindings.get(f.member.assistantId), ["s1", "s2"]);
  assert.deepEqual(
    (await listed(f, "serverId=s2")).memberGrants.map((g) => g.memberName),
    ["Scout"],
  );
  const response = await revoke(f, `task:${f.member.id}:mcp:s1`);
  assert.equal(response.status, 200);
  assert.equal(response.body.kind, "mcp");
  assert.deepEqual(f.bindings.get(f.member.assistantId), ["s2"]);
  assert.deepEqual(f.applied.at(-1)[f.member.assistantId], ["s2"]);
  const record = f.teams.member(f.member.id);
  assert.equal((record.mcpServerIds || []).includes("s1"), false);
  assert.equal(grantAudits(f).at(-1).details.count, 1);
  assert.equal(grantAudits(f).at(-1).source, "user");
});

test("revoking shell or SSH cancels only the waiting cards for what is revoked", async (t) => {
  const f = await setup(t);
  // The lead asks again for shell: a card waits for the owner.
  const asked = await f.call({ grants: { shell: "approval" } });
  assert.equal(asked.status, "approval_requested");
  const [card] = pendingCards(f).filter((a) => a.state === "awaiting_approval");
  assert.equal((await revoke(f, `task:${f.member.id}:ssh`)).status, 200);
  assert.equal(f.agent().inherited.ssh, false);
  assert.equal(f.workflows.store.get(card.id).state, "awaiting_approval");
  assert.equal((await revoke(f, `task:${f.member.id}:shell`)).status, 200);
  assert.equal(f.agent().inherited.shell, "off");
  const cancelled = f.workflows.store.get(card.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.diagnostic, "REVOKED");
  assert.deepEqual(
    grantAudits(f)
      .slice(-2)
      .map((a) => [a.details.grants, a.source]),
    [
      [["ssh"], "user"],
      [["shell"], "user"],
    ],
  );
});

test("coding through the lead and unknown ids cannot be revoked", async (t) => {
  const f = await setup(t);
  const coding = await revoke(f, `task:${f.member.id}:coding:${f.folderProject.id}`);
  assert.equal(coding.status, 400);
  assert.equal((await revoke(f, `task:${f.member.id}:project:elsewhere`)).status, 404);
  assert.equal((await revoke(f, "task:broken")).status, 404);
  assert.equal(f.teams.member(f.member.id).grants.projects[f.folderProject.id], "write");
});

test("the project and MCP overviews carry task member grants beside lead shares", async (t) => {
  const f = await setup(t);
  const view = projectAgents(
    {
      assistants: f.assistants,
      access: f.workflows.access,
      shares: f.workflows.shares,
      memberGrants: f.workflows.memberGrants,
    },
    f.folderProject.id,
  );
  assert.deepEqual(view.shared, []);
  assert.deepEqual(
    view.memberGrants.map((g) => [g.kind, g.name, g.leadName, g.folder, g.revocable]),
    [
      ["project", "Scout", "Home", "write", true],
      ["coding", "Scout", "Home", "none", false],
    ],
  );
  // The read-only list stays for existing consumers.
  assert.equal(view.members[0].folder, "write");
  const changes = new McpChanges({
    assistants: f.assistants,
    servers: f.assistants.mcp.servers,
  });
  const [render, files] = changes.sharedViews([
    { id: "s1", name: "render" },
    { id: "s2", name: "files" },
  ]);
  assert.equal(render.shared, undefined);
  assert.deepEqual(
    render.memberGrants.map((g) => [g.agentName, g.leadName, g.bound]),
    [["Scout", "Home", true]],
  );
  assert.equal(files.memberGrants, undefined);
});

test("permanent shares keep their listing and revocation", async (t) => {
  const f = await leadShareFixture(t);
  await f.share({ grants: { projects: { [f.folderProject.id]: "read" } } });
  const application = express();
  application.use(express.json());
  application.use("/api", assistantLeadShareRoutes({ assistants: f.assistants }));
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const s = application.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/assistant-lead-shares`;
  const body = await (await fetch(`${base}?memberId=${f.member.assistantId}`)).json();
  assert.deepEqual(body.memberGrants, [], "a permanent member has no task grants");
  assert.equal(body.shares.length, 1);
  const removed = await fetch(`${base}/${body.shares[0].id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.deepEqual(f.shares.rows(), []);
});
