import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "./assistant-workflow-fixture.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { LeadRequestStore } from "../../server/features/assistants/lead-request-store.js";
import { MemberGrants } from "../../server/features/assistants/member-grant-requests.js";

/**
 * A lead ("Home", the workflow fixture's agent) with a project folder it holds for
 * coding and read and write, one permanent member "Scout" with its own chat, and a
 * fake MCP server store. Every audit record is kept; the tool guard is live.
 */
export async function leadShareFixture(t) {
  const f = await workflowFixture(t);
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lead-share-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "README.md"), "# Site\n");
  const project = await f.memory.register(folder);
  const audits = [];
  f.services.audit = { append: (event) => audits.push(event) };
  f.assistants.audit = f.services.audit;
  const guard = { live: true };
  f.assistants.config = { writeGuard: () => guard.live, apply: async () => {} };
  const lead = f.id;
  const leadAccess = (projectFiles, extra = {}) =>
    f.workflows.access.save(
      lead,
      {
        ...f.policy,
        projectIds: Object.keys(projectFiles).length ? [project.id] : [],
        projectFiles,
        ...extra,
      },
      f.workflows.access.get(lead).revision,
    );
  leadAccess({ [project.id]: "write" });
  // MCP servers by id; bindings per agent.
  const servers = new Map([
    ["s1", { id: "s1", name: "render", transport: "http" }],
    ["s2", { id: "s2", name: "files", transport: "stdio" }],
  ]);
  const bindings = new Map([[lead, ["s1", "s2"]]]);
  const mcpStore = {
    list: () => [...servers.values()],
    get: (id) => servers.get(id),
    bindings: (_kind, id) => bindings.get(id) || [],
    bindingsByTarget: () => Object.fromEntries(bindings),
  };
  f.assistants.mcp = { servers: mcpStore, pending: false };
  const teams = new TeamStore({
    store: f.store,
    projectFiles: (id) => f.workflows.folders.held(id),
    servers: () => mcpStore,
  });
  const marked = [];
  f.assistants.teams = {
    store: teams,
    requests: {
      refusedChange: (id) => {
        marked.push(id);
        new LeadRequestStore(teams).refusedChange(id);
      },
    },
  };
  // A team with one member, kept as a permanent agent, with its own chat.
  const parent = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "team",
    text: "Build a team",
  });
  teams.recordContext(parent.id, { kind: "owner", teamAllowed: true });
  const parentAttempt = f.assistants.ledger.recordAttempt(parent.id);
  const proposed = teams.propose({
    operationId: "team-call",
    parentAttemptId: parentAttempt.id,
    objective: "Render",
    members: [{ name: "Scout", role: "Render", assignment: "Render the site" }],
  });
  f.assistants.ledger.transition(parentAttempt.id, "completed");
  teams.reserve(proposed.id);
  let member = teams.members(proposed.id)[0];
  const memberChat = f.store.saveConversation({
    assistantId: member.assistantId,
    runtimeSessionKey: "scout-session",
  });
  member = teams.write(member, { conversationId: memberChat.id, phase: "completed" });
  teams.promote(member.id, member.revision);
  member = teams.member(member.id);
  /** One turn in `chatId` with the context AgentPier recorded for it. */
  async function turn(chatId, context = { kind: "owner" }, key = randomUUID()) {
    const sent = await f.assistants.send(
      chatId,
      { clientRequestId: key, text: "Go" },
      context,
    );
    teams.recordContext(sent.request.id, context);
    return {
      attemptId: sent.attempt.id,
      requestId: sent.request.id,
      toolCallId: randomUUID(),
      assertCurrent() {},
    };
  }
  /** A task of the lead for the member, running in a member turn of its own. */
  async function task(patch = {}) {
    const id = randomUUID();
    teams.insert({
      id,
      kind: "lead-request",
      revision: 1,
      type: "task",
      parentAssistantId: lead,
      parentConversationId: f.channel.conversationId,
      memberId: member.id,
      memberAssistantId: member.assistantId,
      memberName: "Scout",
      text: "Render the site",
      origin: { kind: "owner" },
      ownerProof: null,
      writeAllowed: false,
      phase: "running",
      createdAt: new Date().toISOString(),
      ...patch,
    });
    const inv = await turn(
      memberChat.id,
      { kind: "lead-request", requestId: id },
      `lead-request:${id}`,
    );
    teams.write(teams.get(id), { attemptId: inv.attemptId });
    return { id, inv };
  }
  const call = (inv, input) =>
    f.workflows.invoke(
      { ...inv, toolCallId: randomUUID() },
      { projectId: project.id, ...input },
    );
  const grants = new MemberGrants({
    teams,
    assistants: f.assistants,
    audit: f.services.audit,
  });
  const leadTurn = () => turn(f.channel.conversationId);
  const share = async (input) =>
    grants.grant(await leadTurn(), { memberId: member.id, ...input });
  return {
    ...f,
    folder,
    folderProject: project,
    audits,
    guard,
    lead,
    leadAccess,
    servers,
    bindings,
    mcpStore,
    teams,
    member,
    memberChat,
    turn,
    task,
    call,
    grants,
    share,
    leadTurn,
    marked,
    shares: f.workflows.shares,
  };
}
