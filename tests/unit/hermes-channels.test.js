import test from "node:test";
import assert from "node:assert/strict";
import { HermesTurns } from "../../server/features/assistants/runtimes/hermes/hermes-turns.js";
import { hermesEntry } from "../../server/features/assistants/runtimes/hermes/hermes-sessions.js";
import { hermesChannels } from "../../server/features/assistants/runtimes/hermes/hermes-channels.js";
import { fakeHermesSupervisor } from "../helpers/hermes-fake-gateway.js";
import { TelegramSenders } from "../../server/features/assistant-channels/telegram-senders.js";
import {
  attachHermesFleet,
  runtimeFor,
} from "../../server/features/assistants/runtimes/runtime-for.js";

const rows = (list) =>
  list.map(([role, text], i) => {
    const row = { role, text, row_id: i + 1, timestamp: 1 };
    return { ...row, entry: hermesEntry(row, i) };
  });
const runs = (messages) => messages.map((m) => m.entry.runId);

test("Hermes replies are attributed to the turns AgentPier submitted", () => {
  const turns = new HermesTurns();
  const history = rows([
    ["user", "before AgentPier knew"],
    ["assistant", "old reply"],
    ["user", "hello"],
    ["assistant", "first part"],
    ["tool", "output"],
    ["assistant", "ECHO: hello"],
    ["user", "hello"],
    ["assistant", "again"],
    ["user", "typed in Hermes itself"],
    ["assistant", "not ours"],
  ]);
  // Nothing recorded: every row keeps its unknown run.
  assert.equal(turns.attribute("k", history), history);
  turns.record("k", "run-1", "hello ");
  turns.record("k", "run-2", "hello");
  turns.record("other", "run-x", "typed in Hermes itself");
  assert.deepEqual(runs(turns.attribute("k", history)), [
    null,
    null,
    null,
    "run-1",
    null,
    "run-1",
    null,
    "run-2",
    null,
    null,
  ]);
  turns.forget("k");
  assert.deepEqual(runs(turns.attribute("k", history)), Array(10).fill(null));
});

test("a Hermes agent without a bot reports no account; a runtime without channelBots is refused", async () => {
  const supervisor = fakeHermesSupervisor({ agentId: "ap-h" });
  const channels = hermesChannels(supervisor);
  await assert.rejects(
    channels.status({ probe: false }),
    (e) => e.code === "UNAVAILABLE",
  );
  await supervisor.start();
  assert.deepEqual(await channels.status({ probe: false }), {
    channelAccounts: { telegram: [] },
  });
  await supervisor.stop();

  const host = {};
  attachHermesFleet(host, { available: () => true, runtimeOf: () => null });
  const hermesAgent = {
    id: "h",
    runtime: "hermes",
    runtimeAgentId: "ap-h",
    capabilities: {},
    shell: "off",
  };
  const senders = new TelegramSenders({
    store: { get: () => null },
    assistants: {
      runtime: host,
      store: { getAssistant: () => hermesAgent },
      workflows: null,
    },
    secretsGranted: () => false,
    mailGranted: () => false,
    runtimeFor: (agent) => ({
      capabilities: () => ({
        channelBots:
          agent.runtime === "hermes" ? { available: false } : { available: true },
      }),
    }),
  });
  assert.throws(
    () => senders.eligible("h"),
    (e) => e.key === "telegramSendersRuntime" && e.status === 409,
  );
  // OpenClaw runs them, and so does Hermes now (its own adapter, AGENTPIER-341).
  assert.equal(runtimeFor(null, host).capabilities().channelBots.available, true);
});
