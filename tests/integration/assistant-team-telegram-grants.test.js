import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { TeamService } from "../../server/features/assistants/team-service.js";

// The Telegram team approval lists what the lead grants each member.
function setup(t, options) {
  const f = channelFixture(t, options);
  f.assistants.models = { resolve: async () => ({ release() {} }) };
  f.assistants.teams = new TeamService({ assistants: f.assistants, autoStart: false });
  t.after(() => f.assistants.teams.close());
  const original = f.assistants.send;
  f.assistants.send = async (id, input, context) => {
    const sent = await original(id, input);
    f.assistants.teams.store.recordContext(sent.request.id, {
      ...context,
      teamAllowed: input.teamAllowed === true,
    });
    return sent;
  };
  const sends = [];
  f.client.call = async (method, input) => {
    sends.push({ method, input });
    return method === "sendMessage"
      ? { message_id: sends.length, chat: { id: 42 } }
      : true;
  };
  return {
    ...f,
    sends,
    async proposal(
      members = [{ name: "Planner", role: "Plan", assignment: "Make a plan" }],
    ) {
      await f.service.ingress.receive(f.channel.id, [
        telegramMessage(1, "Plan something"),
      ]);
      await f.service.ingress.dispatch(f.channel.id);
      const entry = f.service.ledger.list(f.channel.id)[0];
      f.service.ledger.patch(entry.id, { state: "delivered" });
      const p = await f.assistants.teams.propose(
        { attemptId: entry.attemptId, toolCallId: "call", assertCurrent() {} },
        {
          objective: "Plan",
          members,
        },
      );
      return f.assistants.teams.store.get(p.id);
    },
  };
}
for (const [language, warning, gets] of [
  [
    "de",
    /^⚠ Mit ⚠ markierte Mitglieder erhalten Shell oder SSH/,
    "Erhält: Websuche, ⚠ Shell (mit Freigabe)",
  ],
  [
    "en",
    /^⚠ Members marked ⚠ get shell or SSH/,
    "Gets: web search, ⚠ shell (with approval)",
  ],
])
  test(`the ${language} approval lists each member's grants and warns about shell`, async (t) => {
    const f = setup(t, { language: () => language });
    const lead = f.store.getAssistant(f.channel.assistantId);
    f.store.updateAssistant(
      lead.id,
      {
        shell: "approval",
        capabilities: { memory: false, reminders: false, webSearch: true },
      },
      lead.revision,
    );
    f.assistants.teams.store.savePolicy(lead.id, { memberShellSsh: true }, 1);
    await f.proposal([
      {
        name: "Runner",
        role: "Run",
        assignment: "Run the checks",
        grants: { webSearch: true, shell: "approval" },
      },
    ]);
    await f.service.teamOutbox.transfer();
    const { text } = f.service.outbox.pending(f.channel.id)[0];
    const [, warned, runner] = text.split("\n\n");
    assert.match(warned, warning);
    assert.equal(runner.split("\n").at(-1), gets);
  });
