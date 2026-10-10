import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantServices } from "../../server/application/assistants.js";
import { assistantTeamModel } from "./assistant-team-model.js";
import { ChannelOutbox } from "../../server/features/assistant-channels/channel-outbox.js";
import { teamTools } from "../../server/features/assistants/runtime-config.js";
export async function qualifyAssistantTeams({ dataDir, log = () => {} }) {
  const model = await assistantTeamModel();
  const services = createAssistantServices({
      config: { dataDir },
      providerConnections: { list: () => [] },
    }),
    {
      assistants: a,
      assistantRuntime: runtime,
      assistantTeams: teams,
      assistantChannels: channels,
    } = services;
  const delivered = [];
  channels.clientFactory = () => ({
    call: async (method, params) => {
      assert.equal(method, "sendMessage");
      delivered.push(params);
      return { message_id: delivered.length, chat: { id: 42 } };
    },
  });
  a.models.resolve = model.resolve;
  async function until(predicate, label) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await a.reconcile();
      await teams.reconcile();
      if (await predicate()) {
        log(label);
        return;
      }
      await delay(100);
    }
    throw Error(
      `Qualification timed out: ${label}; team states: ${teams.store
        .list()
        .map((t) => `${t.phase}/${t.resultState}`)
        .join(",")}; members: ${teams.store
        .members()
        .map((m) => m.phase)
        .join(",")}`,
    );
  }
  try {
    await runtime.start();
    log("Pinned gateway ready with installed product plugin");
    const parent = await a.create({
        name: "Qualification parent",
        instructions: "Use the team tool when asked. Keep reports short.",
        model: { connectionId: "fixture", modelId: "fixture-model" },
      }),
      chat = await a.openConversation(parent.id);
    const channel = channels.store.create({
      assistantId: parent.id,
      conversationId: chat.id,
      botId: 123456,
      username: "fixture_bot",
      token: "123456:abcdefghijklmnopqrstuv",
    });
    const pair = channels.store.pairing(channel.id, channel.revision);
    channels.store.acceptPair(channel.id, {
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false },
      text: `/start ${pair.code}`,
    });
    await channels.ingress.receive(channel.id, [
      {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false },
          text: "/team TEAM_PARENT",
        },
      },
    ]);
    await channels.ingress.dispatch(channel.id);
    await until(
      () => teams.store.list()[0]?.resultState === "completed",
      "Four concurrent members and parent synthesis completed",
    );
    const team = teams.store.list()[0],
      members = teams.store.members(team.id);
    assert.equal(team.authorization.kind, "task");
    assert.equal(members.length, 4);
    assert.equal(model.maxConcurrent, 4);
    assert.ok(members.every((m) => m.phase === "completed"));
    assert.deepEqual(
      model.requests[0].tools.map((t) => t.function.name).sort(),
      [...teamTools].sort(),
    );
    const childRequests = model.requests.filter((r) =>
      JSON.stringify(
        r.messages.filter((m) => m.role === "user").at(-1)?.content,
      ).includes("TEAM_CHILD_"),
    );
    assert.ok(childRequests.length >= 4);
    assert.ok(
      childRequests
        .filter(
          (r) =>
            !JSON.stringify(
              r.messages.filter((m) => m.role === "user").at(-1)?.content,
            ).includes("Summarize"),
        )
        .every((r) => r.tools.every((t) => t.function.name === "session_status")),
    );
    await channels.delivery.process(channel.id, new AbortController().signal);
    assert.equal(channels.ledger.list(channel.id)[0].state, "delivered");
    await channels.teamOutbox.transfer();
    await channels.teamOutbox.transfer();
    channels.outbox = new ChannelOutbox(channels.store.db);
    await channels.teamOutbox.process(channel.id, new AbortController().signal);
    assert.equal(
      delivered.filter((p) => p.text === "Four member reports summarized.").length,
      1,
    );
    log("Late source-bound Telegram result delivered once after inbox completion");
    const edited = await a.update(
      members[0].id,
      { instructions: "Independent override" },
      1,
    );
    assert.equal(edited.instructions, "Independent override");
    assert.notEqual(a.store.getAssistant(parent.id).instructions, edited.instructions);
    const promoted = teams.store.promote(
      members[0].id,
      teams.store.member(members[0].id).revision,
    );
    assert.equal(promoted.lifetime, "permanent");
    // Without explicit permission the same actual model tool creates a proposal.
    await a.send(chat.id, { clientRequestId: "ask-first", text: "TEAM_PARENT" });
    await until(
      () => teams.store.list().some((t) => t.phase === "awaiting_approval"),
      "Ask-first proposal remains unallocated",
    );
    const proposal = teams.store.list().at(-1);
    assert.equal(proposal.memberIds.length, 0);
    teams.decide(
      proposal.id,
      { revision: proposal.revision, decision: "decline" },
      { kind: "owner" },
    );
    await until(
      () => !a.ledger.pending().length,
      "Parent finished after declined proposal",
    );
    teams.store.savePolicy(parent.id, { autonomous: true }, 1);
    await a.send(chat.id, { clientRequestId: "standing", text: "TEAM_PARENT" });
    await until(
      () => teams.store.list().at(-1)?.resultState === "completed",
      "Standing permission completed a second bounded team",
    );
    assert.equal(teams.store.list().at(-1).authorization.kind, "standing");
    const installed = JSON.parse(
      fs.readFileSync(path.join(runtime.paths.root, "runtime.json"), "utf8"),
    );
    await runtime.stop();
    fs.unlinkSync(path.join(installed.teamPlugin.directory, "index.js"));
    await runtime.start();
    assert.ok(fs.existsSync(path.join(installed.teamPlugin.directory, "index.js")));
    assert.ok(
      (await a.history(members[0].conversationId)).messages.some(
        (m) => m.text === "A bounded member result.",
      ),
    );
    log("Existing-runtime startup repaired plugin and retained member history");
    model.holdChildren();
    await a.send(chat.id, { clientRequestId: "crash-team", text: "TEAM_PARENT" });
    await until(
      () =>
        teams.store.list().at(-1)?.memberIds.length === 4 &&
        teams.store
          .members(teams.store.list().at(-1).id)
          .every((m) => m.phase === "running"),
      "Four members admitted before active crash",
    );
    const crashedTeam = teams.store.list().at(-1),
      oldPid = runtime.child.pid;
    const requestCount = model.requests.length;
    runtime.child.kill("SIGKILL");
    const restartDeadline = Date.now() + 30000;
    while (
      Date.now() < restartDeadline &&
      (runtime.child?.pid === oldPid || !runtime.client?.ready)
    )
      await delay(100);
    assert.ok(runtime.client?.ready);
    await a.reconcile();
    await teams.reconcile();
    assert.ok(teams.store.members(crashedTeam.id).every((m) => m.phase === "uncertain"));
    assert.equal(
      model.requests.length,
      requestCount,
      "crashed members are never replayed",
    );
    log("Active gateway crash retained four uncertain reservations without replay");
    return {
      runtimeVersion: runtime.status().version,
      platform: process.platform,
      arch: process.arch,
      maxConcurrentMembers: model.maxConcurrent,
      completedTeams: 2,
      askFirstProposals: 1,
      telegramResults: 1,
      crashedMembersRetained: 4,
      realProvider: false,
    };
  } finally {
    await channels.close();
    await a.close();
    await model.close();
  }
}
