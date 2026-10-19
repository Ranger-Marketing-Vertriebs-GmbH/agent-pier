import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "./assistant-workflow-fixture.js";
import { caps } from "./member-grant-fixture.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { TeamMcpBindings } from "../../server/features/assistants/team-mcp.js";
import { MemberGrants } from "../../server/features/assistants/member-grant-requests.js";
import { assistantLeadShareRoutes } from "../../server/http/routes/assistant-lead-shares.js";
import { registerResponses } from "../../server/http/responses.js";

/**
 * A lead ("Home") holding a project folder for coding and read and write, MCP servers
 * "render" (s1) and "files" (s2), shell on approval and "Team members may use shell
 * and SSH", with one running task member "Scout" that the proposal granted the
 * folder, "render", shell and SSH. The lead-share routes are served on a local port;
 * MCP bindings follow the team records (TeamMcpBindings) and every Gateway apply is
 * counted. Every audit record is kept.
 */
export async function taskMemberGrantFixture(t) {
  const f = await workflowFixture(t);
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-grant-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const project = await f.memory.register(folder);
  const audits = [];
  f.services.audit.append = (event) => audits.push(event);
  const lead = f.id;
  const stored = f.store.getAssistant(lead);
  f.store.updateAssistant(
    lead,
    { capabilities: caps, shell: "approval", skills: ["weather"] },
    stored.revision,
  );
  const leadAccess = (projectFiles) =>
    f.workflows.access.save(
      lead,
      {
        ...f.policy,
        projectIds: Object.keys(projectFiles).length ? [project.id] : [],
        projectFiles,
      },
      f.workflows.access.get(lead).revision,
    );
  leadAccess({ [project.id]: "write" });
  const servers = new Map([
    ["s1", { id: "s1", name: "render", transport: "http" }],
    ["s2", { id: "s2", name: "files", transport: "http" }],
  ]);
  const bindings = new Map([[lead, ["s1", "s2"]]]);
  const mcpStore = {
    list: () => [...servers.values()],
    get: (id) => servers.get(id),
    bindings: (_kind, id) => bindings.get(id) || [],
    bindingsByTarget: () => Object.fromEntries(bindings),
    setBindings: (_kind, id, ids) => bindings.set(id, [...ids]),
  };
  const applied = [];
  f.assistants.mcp = {
    servers: mcpStore,
    pending: false,
    applySaved: async () => {
      applied.push(Object.fromEntries(bindings));
      return false;
    },
  };
  const teams = new TeamStore({
    store: f.store,
    sshGranted: () => true,
    projectFiles: (id) => f.workflows.folders.held(id),
    servers: () => mcpStore,
  });
  teams.savePolicy(lead, { memberShellSsh: true }, 1);
  const sync = new TeamMcpBindings({ teams, assistants: f.assistants });
  const grants = new MemberGrants({
    teams,
    assistants: f.assistants,
    audit: f.services.audit,
    onChanged: () => sync.sync(),
  });
  f.assistants.teams = { store: teams, grants };
  const request = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "team",
    text: "Build a team",
  });
  teams.recordContext(request.id, { kind: "owner", teamAllowed: true });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  const proposed = teams.propose({
    operationId: "team-call",
    parentAttemptId: attempt.id,
    objective: "Research",
    members: [
      {
        name: "Scout",
        role: "Research",
        assignment: "Look around",
        mcpServers: ["render"],
        grants: { projects: { [project.id]: "write" }, shell: "approval", ssh: true },
      },
    ],
  });
  if (proposed.phase === "awaiting_approval")
    teams.decide(
      proposed.id,
      { revision: proposed.revision, decision: "approve" },
      { kind: "owner" },
    );
  teams.reserve(proposed.id);
  let member = teams.members(proposed.id)[0];
  const memberChat = f.store.saveConversation({
    assistantId: member.assistantId,
    runtimeSessionKey: "member-session",
  });
  member = teams.write(member, { conversationId: memberChat.id, phase: "running" });
  sync.sync();
  // A tool call of the lead in an owner turn.
  const call = async (input) =>
    grants.grant(await f.invocation(randomUUID()), { memberId: member.id, ...input });
  const agent = () => f.store.getAssistant(member.assistantId);

  const application = express();
  application.use(express.json());
  application.use("/api", assistantLeadShareRoutes({ assistants: f.assistants }));
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const s = application.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
  const http = async (method, url) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    ...f,
    folderProject: project,
    audits,
    lead,
    leadAccess,
    bindings,
    applied,
    teams,
    grants,
    member,
    memberChat,
    call,
    agent,
    http,
  };
}
