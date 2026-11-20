import test from "node:test";
import assert from "node:assert/strict";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import {
  collectEvents,
  contractAgent,
  endsRun,
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";
import { sessionKeyOf } from "../../server/features/assistants/runtimes/hermes/hermes-run-state.js";

// Chats follow the agent's settings (AGENTPIER-438; docs/hermes-runtime.md, "Chats
// follow the agent's settings") on the pinned Hermes as AgentPier runs it
// (AGENTPIER_HERMES_CONTRACT_RUNTIME). Hermes freezes a session's model route and keys
// when it creates it; AgentPier's sessions follow config.yaml instead, and a frozen
// session an older AgentPier created moves to a following successor before its next
// turn. The models are the in-repo fake on loopback ports.
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-follow";

const chats = (model) =>
  model.requests.filter(
    (r) => r.url.endsWith("/chat/completions") && Array.isArray(r.body.tools),
  );
const advisorAsks = (model) =>
  model.requests.filter(
    (r) => r.url.endsWith("/chat/completions") && r.body.tools === undefined,
  );
const resolved = (connectionId, modelId, baseUrl, apiKey) => ({
  connectionId,
  modelId,
  ref: `ap-${connectionId}/${modelId}`,
  providerId: `ap-${connectionId}`,
  provider: {
    baseUrl,
    api: "openai-completions",
    apiKey,
    models: [{ id: modelId, name: modelId, contextWindow: 128000 }],
  },
  display: { connection: connectionId, model: modelId },
});

// Starts the agent on `first`; `turn(key, message)` runs one turn to its end.
async function started(t, first, extra = {}, inputs = {}) {
  const dirs = hermesSandbox(t);
  const hermes = await startHermes(t, dirs, {
    agentId,
    model: { baseUrl: first.baseUrl },
    extra,
    inputs,
  });
  let seen = collectEvents(hermes.events);
  const turn = async (key, message, runId) => {
    const { runId: id } = await hermes.sessions.send({
      key,
      turn: { message },
      idempotencyKey: runId,
    });
    const end = await seen.until(endsRun(id), 180000);
    assert.equal(end.kind, "finished", JSON.stringify(end.payload));
  };
  // An apply as the owner's save makes it; the events follow the new connection.
  const apply = async (model, more = extra, moreInputs = inputs) => {
    seen.unsubscribe();
    await hermes.runtime.config.apply({
      desired: contractAgent(agentId, model, { shell: "approval", ...more }, moreInputs),
    });
    seen = collectEvents(hermes.events);
  };
  t.after(() => seen.unsubscribe());
  return { ...hermes, dirs, turn, apply };
}

test(
  "Hermes contract: an existing chat follows a model connection switch",
  options,
  async (t) => {
    const first = await startFakeModel();
    const second = await startFakeModel();
    t.after(() => first.close());
    t.after(() => second.close());
    const hermes = await started(t, first);
    const { key } = await hermes.sessions.create({ agentId, label: "Main chat" });
    await hermes.turn(key, "hello", "r1");
    assert.ok(chats(first).length >= 1);
    // The owner moves the agent to another connection with another key.
    const before = first.requests.length;
    await hermes.apply({
      baseUrl: second.baseUrl,
      provider: { apiKey: "second-key" },
    });
    await hermes.turn(key, "after the switch", "r2");
    const asked = chats(second);
    assert.ok(asked.length >= 1, "the chat's next turn ran on the new connection");
    assert.match(JSON.stringify(asked.at(-1).body.messages), /after the switch/);
    assert.equal(asked.at(-1).headers.authorization, "Bearer second-key");
    assert.equal(first.requests.length, before, "nothing went to the old connection");
    await hermes.stop();
    assert.deepEqual(await strayAfterStop(hermes.dirs), []);
  },
);

test(
  "Hermes contract: an advisor added later advises an existing chat",
  options,
  async (t) => {
    const main = await startFakeModel();
    const advisor = await startFakeModel();
    t.after(() => main.close());
    t.after(() => advisor.close());
    const hermes = await started(t, main);
    const { key } = await hermes.sessions.create({ agentId, label: "Main chat" });
    await hermes.turn(key, "before", "r1");
    assert.equal(advisorAsks(advisor).length, 0);
    await hermes.apply(
      { baseUrl: main.baseUrl },
      {
        runtime: "hermes",
        runtimeOptions: {
          hermes: { mixture: { advisors: [{ connectionId: "c-adv", modelId: "adv" }] } },
        },
      },
      {
        optionConnections: [resolved("c-adv", "adv", advisor.baseUrl, "advisor-key")],
      },
    );
    await hermes.turn(key, "with an advisor", "r2");
    const asked = advisorAsks(advisor);
    assert.equal(asked.length, 1, "the advisor ran for the existing chat");
    assert.match(JSON.stringify(asked[0].body.messages), /with an advisor/);
    await hermes.stop();
  },
);

test(
  "Hermes contract: a chat an older AgentPier created moves to a following session",
  options,
  async (t) => {
    const first = await startFakeModel();
    const second = await startFakeModel();
    t.after(() => first.close());
    t.after(() => second.close());
    const hermes = await started(t, first);
    // A session as an older AgentPier created it: frozen on the first connection.
    const created = await hermes.supervisor.client.call("session.create", {
      request_id: "older-build",
      title: "Main chat",
    });
    const stored = created.stored_session_id || created.session_id;
    const key = sessionKeyOf(agentId, stored);
    assert.notEqual(created.info?.launch_request?.follow_profile_config, true);
    await hermes.turn(key, "Remember the code 4711.", "r1");
    await hermes.apply({
      baseUrl: second.baseUrl,
      provider: { apiKey: "second-key" },
    });
    await hermes.turn(key, "Which code?", "r2");
    // The turn ran on the new connection, with the conversation so far.
    const asked = chats(second).at(-1);
    assert.ok(asked, "the chat's next turn ran on the new connection");
    const sent = JSON.stringify(asked.body.messages);
    assert.match(sent, /Which code\?/);
    assert.match(sent, /Remember the code 4711\./);
    assert.equal(asked.headers.authorization, "Bearer second-key");
    // The chat's key and its whole history stay.
    const history = await hermes.sessions.history({ sessionKey: key, limit: 50 });
    const visible = history.messages
      .filter((m) => !m.entry.internal && ["user", "assistant"].includes(m.role))
      .map((m) => m.text);
    assert.equal(visible[0], "Remember the code 4711.");
    assert.ok(visible.includes("Which code?"));
    assert.ok(visible.at(-1).length > 0);
    // The successor follows the profile; another turn moves nothing.
    await hermes.turn(key, "Again", "r3");
    const listed = await hermes.supervisor.client.call("session.list", {});
    assert.deepEqual((listed.sessions || []).map((s) => s.title).sort(), [
      "Main chat",
      `Main chat (${stored.slice(-8)})`,
    ]);
    await hermes.stop();
  },
);
