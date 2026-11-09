import { shareFixture } from "./agent-share-fixture.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";
import { AgentCards } from "../../server/features/assistants/agent-cards.js";

/**
 * The share fixture's agent and chat (fake Gateway, paired Telegram channel, real
 * bridge) with agent cards. `f.card(conversation, input)` calls the installed plugin's
 * agentpier_card in that chat's running turn and returns the parsed result;
 * `f.sent` lists the messages the fake Gateway received; `f.cards(chat)` the cards and
 * markers of the chat's history.
 */
export async function cardsFixture(t) {
  const f = await shareFixture(t);
  f.service.cards = new AgentCards({ assistants: f.service });
  const tools = [];
  plugin.register({
    pluginConfig: f.connection,
    registerTool: (factory, options) => tools.push({ factory, options }),
    on() {},
  });
  const card = async (conversation, input, profile = f.agent) => {
    const tool = tools
      .find((entry) => entry.options.name === "agentpier_card")
      .factory.create({
        agentId: profile.runtimeAgentId,
        sessionKey: conversation.runtimeSessionKey,
        assertInvocationCurrent() {},
      });
    try {
      return JSON.parse(
        (await tool.execute(`call-${Math.random()}`, input)).content[0].text,
      );
    } catch (error) {
      // The plugin throws a refusal as "CODE: reason".
      const [, code, reason] = /^([A-Z_]+): (.*)$/s.exec(error.message) || [];
      if (!code) throw error;
      return { code, reason };
    }
  };
  const sent = [];
  const client = f.service.runtime.client;
  const call = client.call;
  client.call = async (method, params, ...rest) => {
    if (method === "sessions.send") sent.push(params.message);
    return call(method, params, ...rest);
  };
  // Settles the chat's running turn, so the next one may start.
  const settle = (attempt) => {
    f.service.ledger.transition(attempt.id, "accepted", { runtimeRunId: attempt.id });
    f.service.ledger.transition(attempt.id, "completed");
  };
  const cards = async (conversation) =>
    (await f.service.history(conversation.id)).messages.filter(
      (m) => m.card || m.cardMoved,
    );
  return { ...f, card, sent, settle, cards };
}

export const plan = {
  title: "Dinners week 46",
  blocks: [
    {
      type: "table",
      columns: ["Day", "Dish"],
      rows: [{ cells: ["Tue", "Lasagne"], action: { label: "Swap" } }],
    },
    {
      type: "checklist",
      title: "Shopping",
      items: [
        { id: "milk", text: "Milk" },
        { id: "rice", text: "Rice" },
      ],
    },
    { type: "actions", items: [{ label: "Recipes for Monday" }] },
  ],
};
