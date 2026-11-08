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
} from "../helpers/hermes-native.js";

// The owner's Thinking level for all agents (hermes-config/advanced.js) on the pinned
// Hermes as AgentPier runs it (AGENTPIER_HERMES_CONTRACT_RUNTIME): Hermes freezes a
// session's level when it creates it, so an existing chat takes a new level only
// because AgentPier resets it before the chat's next turn (hermes-sessions.js), and
// the change needs no restart.
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-agent";

test(
  "Hermes contract: an existing chat takes a new thinking level at its next turn",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const dirs = hermesSandbox(t);
    const advanced = { thinkingDefault: "high" };
    const { runtime, sessions, events, supervisor } = await startHermes(t, dirs, {
      agentId,
      model,
      advanced,
    });
    const seen = collectEvents(events);
    t.after(() => seen.unsubscribe());
    const turn = async (message) => {
      const { runId } = await sessions.send({ key, turn: { message } });
      assert.equal((await seen.until(endsRun(runId), 180000)).kind, "finished");
    };
    // The level the session behind `of` runs at, as Hermes reports it.
    const level = async (of = key) =>
      (
        await supervisor.client.call("session.resume", {
          session_id: of.split(":").at(-1),
          omit_messages: true,
        })
      ).info.reasoning_effort;
    const { key } = await sessions.create({ agentId, label: "Main chat" });
    await turn("hello");
    assert.equal(await level(), "high");
    // The owner sets Off: the home changes live, no restart.
    advanced.thinkingDefault = "off";
    const applied = await runtime.config.apply({
      desired: contractAgent(agentId, model),
    });
    assert.equal(applied.restarted, false);
    // Hermes keeps the session's frozen level until AgentPier resets it ...
    assert.equal(await level(), "high");
    // ... which happens before the chat's next turn.
    await turn("again");
    assert.equal(await level(), "none");
    // A chat created now freezes the new level at once.
    const fresh = await sessions.create({ agentId, label: "Second chat" });
    assert.equal(await level(fresh.key), "none");
  },
);
