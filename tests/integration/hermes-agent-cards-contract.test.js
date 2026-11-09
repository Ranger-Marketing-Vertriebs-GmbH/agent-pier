import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp } from "../helpers/hermes-app.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";

// Agent cards on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME): a Hermes agent
// puts a card into its chat with agentpier_card through its team plugin and the team
// bridge, the person ticks it silently, and the agent's next turn carries the card
// note, which the chat's history leaves out. The in-repo fake model drives the calls.
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };

const card = {
  action: "create",
  title: "Dinners",
  blocks: [
    { type: "checklist", items: [{ id: "milk", text: "Milk" }] },
    { type: "actions", items: [{ label: "Recipes" }] },
  ],
};

test(
  "Hermes contract: an agent shows a card with agentpier_card and sees the ticks",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    const { fleet, assistants } = app;
    const agent = await app.createAgent({ name: "Hermes cards" });
    const paths = fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    const tools = JSON.parse(
      fs.readFileSync(path.join(paths.hermesHome, "plugins/agentpier-team/tools.json")),
    ).tools;
    const offered = tools.find((tool) => tool.name === "agentpier_card");
    assert.ok(offered, "the plugin offers agentpier_card");
    assert.equal(offered.action, "card");

    const chat = await app.chat(agent);
    await chat.send(
      "plan",
      `Plan dinners.\nCALL: agentpier_card ${JSON.stringify(card)}`,
    );
    const done = await chat.reply("TOOL_DONE");
    assert.match(done.text, /"status": "created"/);
    const cardId = /"cardId": "(card_[^"]+)"/.exec(done.text)[1];
    const shown = (await chat.messages()).find((m) => m.card);
    assert.equal(shown.card.id, cardId);
    assert.equal(shown.card.title, "Dinners");

    assistants.cards.check(chat.chat.id, cardId, {
      version: 1,
      block: 0,
      item: "milk",
      checked: true,
    });
    // The first turn settles before the next one may start.
    await eventually(
      () =>
        !assistants.ledger
          .pending()
          .some(
            (a) =>
              assistants.ledger.getRequest(a.requestId).conversationId === chat.chat.id,
          ),
      120000,
      "the first turn to settle",
    );
    await chat.send("next", "What is left to buy?");
    // The fake model echoes the end of the turn's message as the agent received it:
    // the card note with the tick.
    const echoed = await chat.reply(new RegExp(`^ECHO: [\\s\\S]*cardId ${cardId}`));
    assert.match(echoed.text, /ticked "Milk"/);
    const mine = (await chat.messages()).filter((m) => m.role === "user");
    assert.equal(mine.at(-1).text, "What is left to buy?");

    await fleet.close();
    assert.deepEqual(await strayAfterStop({ root: path.dirname(paths.hermesHome) }), []);
  },
);
