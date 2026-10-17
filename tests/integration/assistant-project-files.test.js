import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { assistantBootstrap } from "../../server/features/assistants/assistant-bootstrap.js";

// An agent with a registered project folder outside AgentPier's data directory and
// a switchable tool guard; every audit record is kept.
async function setup(t) {
  const f = await workflowFixture(t);
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-folder-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.mkdirSync(path.join(folder, ".git"));
  fs.writeFileSync(path.join(folder, ".git", "config"), "[core]");
  fs.writeFileSync(path.join(folder, "README.md"), "# App\n");
  const project = await f.memory.register(folder);
  const audits = [];
  f.services.audit = { append: (event) => audits.push(event) };
  const guard = { live: true };
  f.assistants.config = { writeGuard: () => guard.live };
  const grant = (projectFiles, projectIds = [project.id]) =>
    f.workflows.access.save(
      f.id,
      { ...f.policy, projectIds, projectFiles },
      f.workflows.access.get(f.id).revision,
    );
  const call = async (input, origin) =>
    f.workflows.invoke(await f.invocation(randomUUID(), origin), {
      projectId: project.id,
      ...input,
    });
  return { ...f, folder, folderProject: project, audits, guard, grant, call };
}
const code = (key) => (error) => toolError(error).code === key;

test("an owner turn reads a granted folder and writes only with read and write", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.call({ action: "file_read", path: "README.md" }),
    code("PROJECT_NOT_GRANTED"),
  );
  f.grant({ [f.folderProject.id]: "read" });
  assert.equal(
    (await f.call({ action: "file_read", path: "README.md" })).content,
    "# App\n",
  );
  const listed = await f.call({ action: "files_list" });
  assert.deepEqual(
    listed.entries.map((e) => e.name),
    [".git", "README.md"],
  );
  await assert.rejects(
    f.call({ action: "file_write", path: "notes.md", content: "x" }),
    code("PROJECT_READ_ONLY"),
  );
  f.grant({ [f.folderProject.id]: "write" });
  // Without the proven tool guard no change lands.
  f.guard.live = false;
  await assert.rejects(
    f.call({ action: "file_write", path: "notes.md", content: "x" }),
    code("PROJECT_WRITE_UNAVAILABLE"),
  );
  f.guard.live = true;
  const written = await f.call({
    action: "file_write",
    path: "docs/notes.md",
    content: "secret plan",
  });
  assert.equal(written.bytes, 11);
  assert.equal(
    fs.readFileSync(path.join(f.folder, "docs/notes.md"), "utf8"),
    "secret plan",
  );
  await assert.rejects(
    f.call({ action: "file_write", path: ".git/config", content: "x" }),
    code("PROJECT_PATH_REFUSED"),
  );
  await assert.rejects(
    f.call({ action: "file_read", path: ".git/config" }),
    code("PROJECT_PATH_REFUSED"),
  );
  // The other registered project (inside AgentPier's data dir) is not granted.
  await assert.rejects(
    f.workflows.invoke(await f.invocation(), {
      action: "files_list",
      projectId: f.project.id,
    }),
    code("PROJECT_NOT_GRANTED"),
  );
  const audit = f.audits.filter((e) => e.details?.kind === "project-file");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].projectId, f.folderProject.id);
  assert.deepEqual(audit[0].details, {
    kind: "project-file",
    fileChange: "create",
    filePath: "docs/notes.md",
    bytes: 11,
  });
  assert.doesNotMatch(JSON.stringify(f.audits), /secret plan/);
});

test("forwarded and scheduled turns never reach project folders", async (t) => {
  const f = await setup(t);
  f.grant({ [f.folderProject.id]: "write" });
  for (const origin of [{ kind: "owner", forwarded: true }, { kind: "routine" }])
    await assert.rejects(f.call({ action: "file_read", path: "README.md" }, origin), {
      status: 403,
    });
});

test("folder levels follow the granted projects and are validated", async (t) => {
  const f = await setup(t);
  // A level for a project that is not granted is dropped; an unknown level refused.
  const saved = f.grant({ [f.folderProject.id]: "write", [f.project.id]: "read" });
  assert.deepEqual(saved.projectFiles, { [f.folderProject.id]: "write" });
  assert.throws(() => f.grant({ [f.folderProject.id]: "admin" }), { status: 400 });
  // Absent keeps the stored levels; removing the project removes its level.
  const kept = f.workflows.access.save(
    f.id,
    { ...f.policy, projectIds: [f.folderProject.id] },
    f.workflows.access.get(f.id).revision,
  );
  assert.deepEqual(kept.projectFiles, { [f.folderProject.id]: "write" });
  assert.deepEqual(f.grant(undefined, []).projectFiles, {});
  f.grant({ [f.folderProject.id]: "read" });
  f.workflows.revokeProject(f.folderProject.id, f.project.id);
  assert.deepEqual(f.workflows.access.get(f.id).projectFiles, {});
});

test("the bridge serves folder actions in the owner's turn and names refusals", async (t) => {
  const f = await setup(t);
  f.grant({ [f.folderProject.id]: "write" });
  const bridge = new TeamBridge({ assistants: f.assistants, teams: {} });
  await bridge.start();
  t.after(() => bridge.close());
  const agent = f.store.getAssistant(f.id);
  const invoke = async (input) => {
    await f.invocation();
    const { ticket } = bridge.prepare({
      agentId: agent.runtimeAgentId,
      sessionKey: "session",
      toolCallId: randomUUID(),
      action: "workspace",
    });
    return bridge.invoke({
      ticket,
      action: "workspace",
      input: { projectId: f.folderProject.id, ...input },
    });
  };
  for (const attempt of f.assistants.ledger.pending())
    f.assistants.ledger.transition(attempt.id, "completed");
  const landed = await invoke({
    action: "file_edit",
    path: "README.md",
    oldText: "App",
    newText: "Shop",
  });
  assert.equal(landed.replacements, 1);
  assert.equal(fs.readFileSync(path.join(f.folder, "README.md"), "utf8"), "# Shop\n");
  for (const attempt of f.assistants.ledger.pending())
    f.assistants.ledger.transition(attempt.id, "completed");
  fs.symlinkSync(os.tmpdir(), path.join(f.folder, "tmp-link"));
  await assert.rejects(
    invoke({ action: "file_write", path: "tmp-link/escaped.txt", content: "x" }),
    code("PROJECT_PATH_REFUSED"),
  );
  assert.equal(fs.existsSync(path.join(os.tmpdir(), "escaped.txt")), false);
});

// A lead with folder access whose team has one running task member.
async function team(t, memberGrants) {
  const f = await setup(t);
  f.grant({ [f.folderProject.id]: "write" });
  const teams = new TeamStore({
    store: f.store,
    projectFiles: (id) => f.workflows.folders.held(id),
  });
  f.assistants.teams = { store: teams };
  const parentRequest = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "team",
    text: "Build a team that fixes the docs",
  });
  teams.recordContext(parentRequest.id, { kind: "owner", teamAllowed: true });
  const parentAttempt = f.assistants.ledger.recordAttempt(parentRequest.id);
  const proposed = teams.propose({
    operationId: "team-call",
    parentAttemptId: parentAttempt.id,
    objective: "Fix the docs",
    members: [
      { name: "Writer", role: "Docs", assignment: "Fix the docs", grants: memberGrants },
    ],
  });
  f.assistants.ledger.transition(parentAttempt.id, "completed");
  teams.reserve(proposed.id);
  let member = teams.members(proposed.id)[0];
  const chat = f.store.saveConversation({
    assistantId: member.assistantId,
    runtimeSessionKey: "member-session",
  });
  member = teams.write(member, { conversationId: chat.id, phase: "running" });
  const context = { kind: "team-member", teamId: proposed.id, memberId: member.id };
  const turn = await f.assistants.send(
    chat.id,
    { clientRequestId: "assignment", text: member.assignment },
    context,
  );
  teams.recordContext(turn.request.id, context);
  const memberCall = (input) =>
    f.workflows.invoke(
      { attemptId: turn.attempt.id, toolCallId: randomUUID(), assertCurrent() {} },
      { projectId: f.folderProject.id, ...input },
    );
  return { ...f, teams, member, memberCall };
}

test("a lead passes folder access to a member within its own live level", async (t) => {
  const f = await team(t, { projects: {} });
  await assert.rejects(
    f.memberCall({ action: "files_list" }),
    code("PROJECT_NOT_GRANTED"),
  );
  // The lead's grant applies at once, without the owner.
  f.teams.write(f.teams.member(f.member.id), {
    grants: { projects: { [f.folderProject.id]: "read" } },
  });
  assert.equal(
    (await f.memberCall({ action: "file_read", path: "README.md" })).access,
    "read",
  );
  await assert.rejects(
    f.memberCall({ action: "file_write", path: "x.md", content: "x" }),
    code("PROJECT_READ_ONLY"),
  );
  f.teams.write(f.teams.member(f.member.id), {
    grants: { projects: { [f.folderProject.id]: "write" } },
  });
  const written = await f.memberCall({
    action: "file_write",
    path: "x.md",
    content: "draft",
  });
  assert.equal(written.created, true);
  const audit = f.audits.find((e) => e.details?.kind === "project-file");
  assert.equal(audit.details.requestedBy, f.member.id);
  const agent = f.store.getAssistant(f.member.assistantId);
  assert.deepEqual(f.workflows.folders.forAgent(agent), [
    {
      projectId: f.folderProject.id,
      name: f.folderProject.name,
      path: f.folder,
      access: "write",
    },
  ]);
  assert.match(
    assistantBootstrap(
      agent,
      {},
      { projectFolders: f.workflows.folders.forAgent(agent) },
    ),
    /## Project folders[\s\S]*read and write/,
  );
  // The lead drops to read: the member's write goes at once; then the lead loses it.
  f.grant({ [f.folderProject.id]: "read" });
  await assert.rejects(
    f.memberCall({ action: "file_write", path: "x.md", content: "x" }),
    code("PROJECT_READ_ONLY"),
  );
  f.grant({});
  await assert.rejects(
    f.memberCall({ action: "files_list" }),
    code("PROJECT_NOT_GRANTED"),
  );
  assert.deepEqual(f.workflows.folders.forAgent(agent), []);
});

test("a proposal may not grant a folder above the lead's level", async (t) => {
  await assert.rejects(team(t, { projects: { unknown: "read" } }), {
    key: "teamGrantNotHeld",
  });
});

test("a promoted member keeps no folder access its lead granted", async (t) => {
  const f = await team(t, {});
  f.teams.write(f.teams.member(f.member.id), {
    grants: { projects: { [f.folderProject.id]: "write" } },
  });
  for (const attempt of f.assistants.ledger.pending())
    f.assistants.ledger.transition(attempt.id, "completed");
  const member = f.teams.member(f.member.id);
  f.teams.promoteByLead(member.id, member.revision, {
    settings: { capabilities: {}, skills: [], shell: "off" },
  });
  const agent = f.store.getAssistant(member.assistantId);
  assert.equal(agent.lifetime, "permanent");
  assert.deepEqual(f.workflows.folders.forAgent(agent), []);
  assert.deepEqual(f.workflows.folders.levels({ requestedBy: member.id }), {});
});
