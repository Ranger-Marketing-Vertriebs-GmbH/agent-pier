import test from "node:test";
import assert from "node:assert/strict";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { deleteAgent, hermesApp, json } from "../helpers/hermes-app.js";

// A Hermes agent's clarify question, end to end on the pinned Hermes
// (AGENTPIER_HERMES_CONTRACT_RUNTIME): the fake model calls the `clarify` tool, the
// question waits in the agent's AgentPier chat (agent-questions.js, the chat feed's
// `questions`), the owner answers it through the chat's route, the answer reaches
// Hermes through `clarify.respond` and the turn goes on with it.
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };

test(
  "Hermes contract: a clarify question waits in the chat and the owner's answer goes back",
  options,
  async (t) => {
    const app = await hermesApp(t);
    const { f, assistants, agent, runtime } = app;
    const chat = await json(
      await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" }),
    );
    const sent = await f.request(`/api/assistant-conversations/${chat.id}/messages`, {
      method: "POST",
      body: { clientRequestId: "ask", text: "ASK: Which stage?" },
    });
    assert.ok([200, 201, 202].includes(sent.status), await sent.clone().text());
    let question;
    await eventually(
      () => (question = assistants.questions.list(chat.id)[0]),
      240000,
      "the question in the chat",
    );
    assert.equal(question.question, "Which stage?");
    // Hermes marks the first choice as the agent's recommendation.
    assert.deepEqual(question.choices, ["staging (Recommended)", "prod"]);
    assert.ok(question.expiresAt > Date.now());
    // The chat feed carries it to the chat's question card.
    const feed = await json(
      await f.request(`/api/assistant-conversations/${chat.id}/messages?cursor=`),
    );
    assert.deepEqual(
      (feed.questions || feed.metadata?.questions).map((q) => q.id),
      [question.id],
    );
    assert.equal((await runtime.approvals.questions()).length, 1);
    // The owner picks a choice; an unknown question is refused.
    await json(
      await f.request(
        `/api/assistant-conversations/${chat.id}/questions/unknown/answer`,
        { method: "POST", body: { answer: "prod" } },
      ),
      404,
    );
    await json(
      await f.request(
        `/api/assistant-conversations/${chat.id}/questions/${encodeURIComponent(question.id)}/answer`,
        { method: "POST", body: { answer: "prod" } },
      ),
    );
    assert.deepEqual(assistants.questions.list(chat.id), []);
    await eventually(
      async () => {
        await assistants.reconcile({ full: false, chats: [chat.id] }).catch(() => {});
        const { messages } = await assistants.history(chat.id);
        return messages.some(
          (m) => m.role === "assistant" && m.text.includes("ANSWERED: prod"),
        );
      },
      240000,
      "the turn to go on with the answer",
    );
    assert.deepEqual(await runtime.approvals.questions(), []);
    // The turn settles in AgentPier's ledger before the agent goes.
    await eventually(
      async () => {
        await assistants.reconcile({ full: false, chats: [chat.id] }).catch(() => {});
        return !assistants.ledger
          .pending()
          .some(
            (a) => assistants.ledger.getRequest(a.requestId).conversationId === chat.id,
          );
      },
      60000,
      "the turn to settle",
    );
    const home = app.fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    await deleteAgent(app);
    await eventually(
      () => runtime.host.status().availability === "disabled",
      60000,
      "the agent's set to stop",
    );
    assert.deepEqual(await strayAfterStop({ root: home.hermesHome }), []);
    assert.deepEqual(await strayAfterStop({ root: f.dataDir }), []);
  },
);
