import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { eventually, shellGateway } from "../helpers/assistant-shell-gateway.js";
import { AgentQuestions } from "../../server/features/assistants/agent-questions.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { runtimeFor } from "../../server/features/assistants/runtimes/runtime-for.js";
import { GatewayClient } from "../../server/features/assistants/runtimes/openclaw/gateway-client.js";
import { gatewayHandshake } from "../../server/features/assistants/runtimes/openclaw/gateway-protocol.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";

// An OpenClaw agent's ask_user question, end to end on the pinned Gateway
// (AGENTPIER_SHELL_CONTRACT_RUNTIME): the fixture model calls `ask_user`, the Gateway
// broadcasts `question.requested` to AgentPier's operator connection (its handshake
// as it is: no cap for questions, scope operator.admin), the question waits in the
// chat of its session (agent-questions.js), the owner's answers go back through
// `question.resolve` and the turn goes on with them. Also what ends a question
// without an answer, and who is offered the tool.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const tools = ["session_status", "ask_user"];
const permissions = (allow = tools) => ({
  tools: { allow: tools },
  agents: { entries: { main: { tools: { allow } } } },
});
const stage = {
  id: "deploy_target",
  header: "Stage",
  question: "Which stage?",
  options: [
    { label: "Staging (Recommended)", description: "The test system" },
    { label: "Production" },
  ],
};
const regions = {
  id: "regions",
  header: "Regions",
  question: "Which regions?",
  options: [{ label: "EU" }, { label: "US" }, { label: "Asia" }],
  multiSelect: true,
};

// AgentQuestions over the Gateway's real adapter: every session the test sends a
// turn in is a chat of the agent `main`, unless it is left out of `chats`.
function questionsOf(gw) {
  const chats = new Map();
  const changes = [];
  const service = {
    runtime: gw.runtime,
    gatewayEvents: new GatewayEventHub(),
    store: {
      listConversations: () => [...chats.values()],
      getAssistant: () => ({ id: "a1", name: "Helper", runtimeAgentId: "main" }),
    },
    changed: (change) => changes.push(change),
  };
  const questions = new AgentQuestions(service);
  const bind = () => service.gatewayEvents.bind(runtimeFor(null, gw.runtime).events);
  bind();
  return {
    questions,
    changes,
    service,
    bind,
    chat(run) {
      const id = `c-${chats.size + 1}`;
      chats.set(id, { id, assistantId: "a1", runtimeSessionKey: run.session.key });
      return id;
    },
  };
}
// A turn in a new session whose model calls ask_user once; `known` makes it a chat.
async function ask(gw, app, label, args, { known = true } = {}) {
  gw.tool.name = "ask_user";
  gw.tool.arguments = args;
  const from = gw.model.requests.length;
  const session = await createGatewaySession(gw.client, { agentId: "main", label });
  const run = { session, from, runId: label };
  const chat = known ? app.chat(run) : null;
  await gw.client.call("sessions.send", {
    key: session.key,
    message: "Ask me.",
    idempotencyKey: label,
  });
  return { run, chat };
}
const waiting = (app, chat) =>
  eventually(() => app.questions.list(chat)[0], { tries: 300, ms: 200 });
const result = (settled) => JSON.parse(settled.result.slice(settled.result.indexOf("{")));

test(
  "OpenClaw contract: ask_user questions wait in the chat and the owner's answers go back",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "ask-user-contract-" });
    await gw.configure(permissions());
    const app = questionsOf(gw);

    // One question: its record as the chat's question, answered with an option.
    const one = await ask(gw, app, "ask-one", {
      questions: [stage],
      timeoutSeconds: 120,
    });
    const first = await waiting(app, one.chat);
    assert.ok(first, "the question in the chat");
    assert.equal(first.runId, "ask-one");
    assert.deepEqual(first.questions, [
      {
        id: "deploy_target",
        header: "Stage",
        text: "Which stage?",
        options: [
          { label: "Staging (Recommended)", description: "The test system" },
          { label: "Production" },
        ],
        multiSelect: false,
        // OpenClaw always takes an own answer for ask_user.
        other: true,
      },
    ]);
    // The tool's timeout is the question's expiry.
    const left = first.expiresAt - Date.now();
    assert.ok(left > 60000 && left <= 120000, String(left));
    const { approvals } = runtimeFor(null, gw.runtime);
    assert.deepEqual(
      (await approvals.questions()).map((q) => q.id),
      [first.id],
    );
    await assert.rejects(
      app.questions.answer(one.chat, first.id, { answers: { deploy_target: [] } }),
      { status: 400 },
    );
    await app.questions.answer(one.chat, first.id, {
      answers: { deploy_target: ["Production"] },
    });
    assert.deepEqual(app.questions.list(one.chat), []);
    const answered = await gw.settle(one.run);
    assert.deepEqual(result(answered), {
      status: "answered",
      answers: { answers: { deploy_target: ["Production"] } },
    });
    assert.deepEqual(await approvals.questions(), []);
    // A second answer finds the question gone.
    await assert.rejects(
      approvals.answer({ id: first.id, answers: { deploy_target: ["Production"] } }),
      (error) => error.answered === true,
    );

    // Three questions in one request: a single choice, several options and an own
    // text, answered in one piece.
    const note = { ...stage, id: "note", header: "Note", question: "Anything else?" };
    const many = await ask(gw, app, "ask-many", { questions: [stage, regions, note] });
    const second = await waiting(app, many.chat);
    assert.deepEqual(
      second.questions.map((q) => [q.id, q.multiSelect]),
      [
        ["deploy_target", false],
        ["regions", true],
        ["note", false],
      ],
    );
    // 15 minutes unless the agent names a timeout.
    const standard = second.expiresAt - second.createdAt;
    assert.equal(standard, 900000);
    await app.questions.answer(many.chat, second.id, {
      answers: {
        deploy_target: ["Staging (Recommended)"],
        regions: ["EU", "Asia"],
        note: ["Ship it on Friday"],
      },
    });
    assert.deepEqual(result(await gw.settle(many.run)).answers.answers, {
      deploy_target: ["Staging (Recommended)"],
      regions: ["EU", "Asia"],
      note: ["Ship it on Friday"],
    });
  },
);

test(
  "OpenClaw contract: a question ends with its turn, its timeout, or at once where nobody can answer",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "ask-user-ends-contract-" });
    await gw.configure(permissions());
    const app = questionsOf(gw);
    const { approvals, sessions } = runtimeFor(null, gw.runtime);

    // The owner stops the turn: OpenClaw withdraws its question.
    const stopped = await ask(gw, app, "ask-stop", { questions: [stage] });
    const open = await waiting(app, stopped.chat);
    assert.ok(open);
    await sessions.abort({ key: stopped.run.session.key, runId: "ask-stop" });
    assert.ok(
      await eventually(() => app.questions.list(stopped.chat).length === 0),
      "the question to leave the chat",
    );
    assert.deepEqual(await approvals.questions(), []);

    // Nobody answers: after the tool's timeout (30 seconds at least) the agent
    // reads that and goes on.
    const silent = await ask(gw, app, "ask-silent", {
      questions: [stage],
      timeoutSeconds: 1,
    });
    const timed = await waiting(app, silent.chat);
    const wait = timed.expiresAt - timed.createdAt;
    assert.equal(wait, 30000);
    assert.deepEqual(result(await gw.settle(silent.run)), { status: "no_answer" });
    assert.ok(await eventually(() => app.questions.list(silent.chat).length === 0));

    // A session that is no chat of AgentPier: declined at once, the agent goes on.
    const before = Date.now();
    const unknown = await ask(
      gw,
      app,
      "ask-unknown",
      { questions: [stage] },
      { known: false },
    );
    assert.deepEqual(result(await gw.settle(unknown.run)), { status: "no_answer" });
    assert.ok(Date.now() - before < 25000, "declined before any timeout");
    assert.deepEqual(await approvals.questions(), []);
  },
);

test(
  "OpenClaw contract: a connection that missed a question finds it waiting",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "ask-user-resync-contract-" });
    await gw.configure(permissions());
    const app = questionsOf(gw);
    // AgentPier's connection is away while the agent asks: no event reaches it.
    app.service.gatewayEvents.bind(null);
    const missed = await ask(gw, app, "ask-missed", { questions: [stage] });
    const { approvals } = runtimeFor(null, gw.runtime);
    let held = [];
    for (let n = 0; n < 150 && !held.length; n++) {
      await delay(200);
      held = await approvals.questions();
    }
    assert.equal(held.length, 1, "the Gateway to hold the question");
    assert.deepEqual(app.questions.list(missed.chat), []);
    // Ready again: the listing brings the question into its chat.
    app.bind();
    await app.questions.resync();
    const [found] = app.questions.list(missed.chat);
    assert.equal(found.questions[0].text, "Which stage?");
    await app.questions.answer(missed.chat, found.id, { answer: "2" });
    assert.deepEqual(result(await gw.settle(missed.run)).answers.answers, {
      deploy_target: ["Production"],
    });
    // A listing after the end drops nothing and brings nothing back.
    await app.questions.resync();
    assert.deepEqual(app.questions.list(missed.chat), []);
  },
);

test(
  "OpenClaw contract: ask_user is offered only where it is granted and question input exists",
  options,
  async (t) => {
    const gw = await shellGateway(t, installed, { prefix: "ask-user-offer-contract-" });
    const app = questionsOf(gw);
    const asked = () => gw.model.requests.at(-1).messages.some((m) => m.role === "tool");
    // Not in the agent's tools.allow (a user agent, a member, a bot for others).
    await gw.configure(permissions(["session_status"]));
    const denied = await ask(gw, app, "ask-denied", { questions: [stage] });
    await gw.settle(denied.run);
    assert.equal(asked(), false);
    assert.deepEqual(app.questions.list(denied.chat), []);

    // A client that declares "no-question-input" takes the tool from its turns,
    // which is why AgentPier's handshake never declares it.
    await gw.configure(permissions());
    assert.equal(
      gatewayHandshake("t", gw.client.caps).caps.includes("no-question-input"),
      false,
    );
    const mute = new GatewayClient({
      url: gw.client.url,
      token: gw.client.token,
      certPath: gw.client.certPath,
      caps: ["no-question-input"],
    });
    t.after(() => mute.close());
    await mute.connect();
    gw.tool.name = "ask_user";
    gw.tool.arguments = { questions: [stage] };
    const session = await createGatewaySession(mute, { agentId: "main", label: "mute" });
    const from = gw.model.requests.length;
    await mute.call("sessions.send", {
      key: session.key,
      message: "Ask me.",
      idempotencyKey: "ask-mute",
    });
    await gw.settle({ session, from, runId: "ask-mute" });
    assert.equal(asked(), false);
  },
);
