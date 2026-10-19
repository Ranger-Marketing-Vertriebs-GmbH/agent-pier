import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { e2eGraph, turnOf } from "../helpers/assistant-e2e-graph.js";

// Recorded end-to-end run (AGENTPIER-173): the owner has a lead agent build a team
// whose member stays permanent, then asks the lead to delegate a coding task. The
// lead shares a project for that task only (lead shares), the member requests a
// coding run, the owner approves it through AgentPier's route, the run executes on
// AgentPier's pipeline engine (stub stage driver, no coding CLI), and the member's
// result reaches the lead's chat as a member-result turn. A second task ends before
// the owner approves its run, which still runs on the task's share. The production
// assistant graph runs on the pinned runtime with a scripted loopback model.
const installed = process.env.AGENTPIER_E2E_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_E2E_CONTRACT_RUNTIME",
  timeout: 300000,
};

test(
  "lead delegates a coding task that runs after the owner's approval",
  options,
  async (t) => {
    const h = await e2eGraph(t, installed, { prefix: "agentpier-e2e-team-" });
    const folder = path.join(h.dataDir, "site");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "README.md"), "# Site\n");
    const project = await h.memory.register(folder);
    h.pipelines.state.projectId = project.id;
    const connection = h.connection();
    await h.start();
    h.note("gateway ready");
    const workflows = h.graph.assistantWorkflows;
    const ids = { member: null, memberAssistant: null };

    // The scripted model, by turn: the lead proposes a team and later delegates; the
    // member reports ready, then works on the task: it requests the run, waits for it
    // to end, reads its status and reports.
    h.model.reply = async (request) => {
      const turn = turnOf(request);
      const call = (name, args) => ({ tool: { name, arguments: args } });
      if (turn.user.includes("Follow-up for the owner"))
        return turn.user.includes("E2E_MEMBER_QUEUED")
          ? { text: "E2E_LEAD_QUEUED Builder's run waits for your approval." }
          : { text: "E2E_LEAD_SUMMARY Builder finished the coding run." };
      if (turn.user.includes("E2E_PROPOSE"))
        return turn.results.length
          ? { text: "Proposed a team." }
          : call("agentpier_team_propose", {
              objective: "Keep the site building",
              members: [
                {
                  name: "Builder",
                  role: "Developer",
                  assignment: "Say that you are ready. E2E_ASSIGNMENT",
                },
              ],
            });
      if (turn.user.includes("E2E_ASSIGNMENT")) return { text: "E2E_MEMBER_READY" };
      // The second task: the member requests a run and ends its task at once.
      if (turn.user.includes("E2E_DELEGATE_AGAIN"))
        return turn.results.length
          ? { text: "Delegated again." }
          : call("agentpier_team_delegate", {
              memberId: ids.member,
              task: "Start another build of the site project. E2E_SECOND_TASK",
              access: { coding: [project.id] },
            });
      if (turn.user.includes("E2E_SECOND_TASK"))
        return turn.results.length
          ? { text: "E2E_MEMBER_QUEUED requested a run; it waits for the owner." }
          : call("agentpier_workspace", {
              action: "coding_start",
              projectId: project.id,
              pipelineId: "pipeline",
              task: "Build again E2E_CODING_AGAIN",
            });
      if (turn.user.includes("E2E_DELEGATE"))
        return turn.results.length
          ? { text: "Delegated to Builder." }
          : call("agentpier_team_delegate", {
              memberId: ids.member,
              task: "Run the build pipeline on the site project. E2E_TASK",
              access: { coding: [project.id] },
            });
      if (turn.user.includes("E2E_TASK")) {
        if (turn.results.length === 0)
          return call("agentpier_workspace", {
            action: "coding_start",
            projectId: project.id,
            pipelineId: "pipeline",
            task: "Fix the build E2E_CODING",
          });
        if (turn.results.length === 1) {
          // The member keeps its task open until the owner decided and the run ended.
          const action = await h.until(
            () =>
              workflows.store
                .list(ids.memberAssistant)
                .find(
                  (a) =>
                    a.payload.action === "coding_start" &&
                    a.runId &&
                    ["completed", "failed", "cancelled"].includes(a.state),
                ),
            "the run ends",
          );
          return call("agentpier_workspace", { action: "coding_status", id: action.id });
        }
        const status = turn.results.at(-1).match(/"status":"(\w+)"/)?.[1];
        return { text: `E2E_MEMBER_RESULT the coding run ended ${status}.` };
      }
      if (turn.user.includes("E2E_MEMBER_READY"))
        return { text: "E2E_TEAM_SUMMARY Builder is ready." };
      return { text: "Okay." };
    };

    // The owner creates the lead and grants it the project and the pipeline.
    const lead = await h.http("POST", "/assistants", {
      name: "Lead",
      instructions: "Lead a team.",
      model: { connectionId: connection.id, modelId: "fixture-model" },
    });
    const access = await h.http("GET", `/assistants/${lead.id}/access`);
    await h.http("PUT", `/assistants/${lead.id}/access`, {
      revision: access.revision,
      projectIds: [project.id],
      pipelineIds: ["pipeline"],
      memoryWrite: false,
      autonomous: false,
      publish: false,
    });
    const chat = await h.http("POST", `/assistants/${lead.id}/conversations`);
    const say = (text) =>
      h.http("POST", `/assistant-conversations/${chat.id}/messages`, {
        clientRequestId: crypto.randomUUID(),
        text,
      });
    const idle = () =>
      h.until(async () => {
        const pending = h.graph.assistants.ledger
          .pending()
          .filter(
            (a) =>
              h.graph.assistants.ledger.getRequest(a.requestId).conversationId ===
              chat.id,
          );
        return !pending.length;
      }, "the lead's chat is idle");

    // A team whose member the owner keeps as a permanent agent.
    await say("Build a small team for the site. E2E_PROPOSE");
    const proposal = await h.until(async () => {
      const listed = await h.http("GET", "/assistant-teams");
      return listed.teams.find((x) => x.phase === "awaiting_approval");
    }, "team proposal");
    h.note("lead proposed a team");
    await h.http("POST", `/assistant-team-proposals/${proposal.id}/decision`, {
      revision: proposal.revision,
      decision: "approve",
      lifetime: "permanent",
    });
    h.note("owner approved the team (permanent members)");
    const team = await h.until(async () => {
      const listed = await h.http("GET", "/assistant-teams");
      const found = listed.teams.find((x) => x.id === proposal.id);
      return found?.phase === "completed" && found;
    }, "team completed");
    h.note("team completed");
    const [member] = h.graph.assistantTeams.store.members(team.id);
    assert.equal(member.lifetime, "permanent");
    ids.member = member.id;
    ids.memberAssistant = member.assistantId;
    await idle();

    // The owner asks for the coding task; the lead delegates with a task share.
    await say("Ask Builder to run the build pipeline on the site. E2E_DELEGATE");
    const request = await h.until(
      () =>
        h.graph.assistantTeams.requests.store
          .list(lead.id)
          .find((r) => r.type === "task"),
      "delegated task",
    );
    h.note("lead delegated the task");
    const pending = await h.until(async () => {
      const listed = await h.http("GET", `/assistants/${lead.id}/actions`);
      return listed.actions.find(
        (a) => a.payload?.action === "coding_start" && a.state === "awaiting_approval",
      );
    }, "coding request awaiting the owner");
    h.note("member requested a coding run (awaiting approval)");
    t.diagnostic(`request=${JSON.stringify(pending).slice(0, 600)}`);
    assert.equal(pending.assistantId, member.assistantId);
    assert.equal(pending.leadAssistantId, lead.id);
    assert.equal(
      workflows.store.get(pending.id).inherited?.leadId,
      lead.id,
      "on the lead's task share",
    );
    assert.equal(
      h.pipelines.launches.length,
      0,
      "nothing runs before the owner approves",
    );
    await h.http("POST", `/assistant-actions/${pending.id}/decision`, {
      revision: pending.revision,
      decision: "approve",
    });
    h.note("owner approved the coding run");
    const ended = await h.until(() => {
      const a = workflows.store.get(pending.id);
      return ["completed", "failed", "cancelled"].includes(a.state) && a;
    }, "coding run ended");
    h.note(`coding run ${ended.state}`);
    assert.equal(ended.state, "completed");
    assert.equal(h.pipelines.launches.length, 1);
    assert.equal(h.pipelines.engine.get(ended.runId).projectId, project.id);

    // The member reports, the task completes and its result reaches the lead's chat.
    const done = await h.until(() => {
      const r = h.graph.assistantTeams.requests.store.get(request.id);
      return r.resultAttemptId && r.resultState === "completed" && r;
    }, "member result delivered to the lead");
    h.note("member-result turn completed in the lead's chat");
    assert.equal(done.phase, "completed");
    assert.match(done.answer, /E2E_MEMBER_RESULT the coding run ended completed/);
    const followUp = h.model.requests.find((r) =>
      turnOf(r).user.includes("Follow-up for the owner"),
    );
    assert.match(
      turnOf(followUp).user,
      /E2E_MEMBER_RESULT the coding run ended completed/,
    );
    // What each chat shows: the lead's team result, its task share and the member's
    // result, then its summary; the run's notes in the member's own chat.
    const outline = (messages) =>
      messages.map((m) =>
        m.role === "event"
          ? `event:${m.event}`
          : `${m.role}:${String(m.text).slice(0, 40)}`,
      );
    const leadChat = outline((await h.history(chat.id)).messages);
    const memberChat = outline((await h.history(member.conversationId)).messages);
    t.diagnostic(`lead chat=${JSON.stringify(leadChat)}`);
    t.diagnostic(`member chat=${JSON.stringify(memberChat)}`);
    const order = (list, items) =>
      items.map((item) => list.findIndex((entry) => entry.startsWith(item)));
    const leadOrder = order(leadChat, [
      "event:team-result",
      "event:member-grant",
      "event:member-result",
      "assistant:E2E_LEAD_SUMMARY",
    ]);
    assert.ok(
      leadOrder.every((i, n) => i >= 0 && (n === 0 || i > leadOrder[n - 1])),
      "lead chat",
    );
    const memberOrder = order(memberChat, [
      "event:coding-run",
      "assistant:E2E_MEMBER_RESULT",
    ]);
    assert.ok(
      memberOrder.every((i) => i >= 0),
      "member chat",
    );
    assert.equal(
      memberChat.filter((entry) => entry === "event:coding-run").length,
      2,
      "started and result notes",
    );

    // A member that ends its task right after the request: the lead reports that the
    // run waits, and the owner's later approval still runs it on the task's share.
    await idle();
    await say("Ask Builder to build the site again. E2E_DELEGATE_AGAIN");
    const second = await h.until(
      () =>
        h.graph.assistantTeams.requests.store
          .list(lead.id)
          .find((r) => r.type === "task" && r.id !== request.id),
      "second task",
    );
    h.note("lead delegated a second task");
    const queued = await h.until(() => {
      const r = h.graph.assistantTeams.requests.store.get(second.id);
      return r.resultAttemptId && r.resultState === "completed" && r;
    }, "second member result delivered");
    h.note("member ended its task; member-result turn completed in the lead's chat");
    assert.match(queued.answer, /E2E_MEMBER_QUEUED/);
    const waiting = (await h.http("GET", `/assistants/${lead.id}/actions`)).actions.find(
      (a) => a.payload?.task === "Build again E2E_CODING_AGAIN",
    );
    assert.equal(waiting.state, "awaiting_approval");
    await h.http("POST", `/assistant-actions/${waiting.id}/decision`, {
      revision: waiting.revision,
      decision: "approve",
    });
    h.note("owner approved the second run after the task ended");
    const later = await h.until(() => {
      const a = workflows.store.get(waiting.id);
      return ["completed", "failed", "cancelled"].includes(a.state) && a;
    }, "second run ended");
    h.note(`second coding run ${later.state}`);
    assert.equal(later.state, "completed", JSON.stringify(later.diagnostic));
    assert.equal(h.pipelines.launches.length, 2);
    t.diagnostic(`events=${JSON.stringify(h.events)}`);
  },
);
