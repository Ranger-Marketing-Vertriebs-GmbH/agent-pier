import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp, json } from "../helpers/hermes-app.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";

// Visible teams on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME): a Hermes
// lead calls AgentPier's team tools through its team plugin, its proposal becomes a
// team whose member runs as a Hermes agent of its own with its own chat in
// AgentPier, the lead delegates a task to it, and the plugin's guard keeps that
// read-only task from writing a file. The in-repo fake model drives every tool call.
const options = { skip: hermesSkip, timeout: contractTimeout(1500000) };

// The first truthy answer of `check` within `ms`.
async function until(check, ms, label) {
  let value;
  await eventually(async () => !!(value = await check()), ms, label);
  return value;
}

test(
  "Hermes contract: a lead builds a team, delegates, and the guard keeps a read-only task from writing",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    const { assistants, fleet } = app;
    const lead = await app.createAgent({ name: "Hermes lead" });
    const leadHome = fleet.sets.get(lead.runtimeAgentId).supervisor.agentPaths();
    const config = readHermesConfig(
      fs.readFileSync(path.join(leadHome.hermesHome, "config.yaml"), "utf8"),
    );
    assert.ok(config.plugins.enabled.includes("agentpier-team"));

    // Members only on the owner's request: a task the owner did not ask for runs
    // read-only (the default, autonomous, lets a lead's own task write).
    const { revision, ...policy } = assistants.teams.store.policy(lead.id);
    await json(
      await app.f.request(`/api/assistants/${lead.id}/team-policy`, {
        method: "PUT",
        body: { ...policy, usage: "onRequest", revision },
      }),
    );

    // The owner asks for a team; the lead proposes it with the team tool.
    const chat = await app.chat(lead);
    const ask = "Please build a team that reviews the plan.";
    const proposal = {
      objective: "Review the plan",
      members: [
        { name: "Scout", role: "Reviewer", assignment: "Say hello to the lead." },
      ],
      ownerRequestedTeam: true,
      ownerRequestQuote: ask,
    };
    await chat.send(
      "team",
      `${ask}\nCALL: agentpier_team_propose ${JSON.stringify(proposal)}`,
    );
    const proposed = await chat.reply("TOOL_DONE");
    assert.match(proposed.text, /"kind": "team".*"memberIds": \["/);
    const team = await until(
      () => assistants.teams.store.list().find((t) => t.parentAssistantId === lead.id),
      60000,
      "the team",
    );
    assert.equal(team.objective, "Review the plan");

    // The member is a Hermes agent of its own, provisioned with its own chat.
    const record = await until(
      () =>
        assistants.teams.store
          .members(team.id)
          .find((m) => m.conversationId && m.assistantId),
      300000,
      "the provisioned member",
    );
    const member = assistants.store.getAssistant(record.assistantId);
    assert.equal(member.runtime, "hermes");
    assert.equal(member.name, "Scout");
    await app.ready(member);
    const memberChat = app.conversation(
      assistants.store.getConversation(record.conversationId),
    );
    assert.match(
      memberChat.chat.runtimeSessionKey,
      new RegExp(`^agent:${member.runtimeAgentId}:hermes:`),
    );
    await memberChat.reply("ECHO:");

    // The lead delegates a task; the member's attempt to change a file is refused,
    // because a task the owner did not ask for runs read-only.
    const task = `CALL: write_file ${JSON.stringify({ path: "notes.txt", content: "draft" })}`;
    await chat.send(
      "delegate",
      `CALL: agentpier_team_delegate ${JSON.stringify({ memberId: record.id, task })}`,
    );
    const delegated = await chat.reply(/TOOL_DONE: .*requestId/);
    assert.doesNotMatch(delegated.text, /error/i);
    const refused = await memberChat.reply(
      "Only the owner's own messages may change files.",
    );
    assert.match(refused.text, /TOOL_DONE/);
    const memberHome = fleet.sets.get(member.runtimeAgentId).supervisor.agentPaths();
    assert.equal(fs.existsSync(path.join(memberHome.workspace, "notes.txt")), false);
    // The task and its answer are AgentPier's lead request, shown to the owner.
    await eventually(
      () =>
        assistants.teams.requests.store
          .pending()
          .every((r) => r.memberAssistantId !== member.id),
      240000,
      "the delegated task to settle",
    );

    await fleet.close();
    assert.deepEqual(
      await strayAfterStop({ root: path.dirname(leadHome.hermesHome) }),
      [],
    );
  },
);
