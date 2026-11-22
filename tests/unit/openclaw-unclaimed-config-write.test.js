import test from "node:test";
import assert from "node:assert/strict";
import {
  configWrite,
  patchConfig,
} from "../../server/features/assistants/runtimes/openclaw/live-patch.js";
import { persistedWrite } from "../../server/features/assistants/runtimes/openclaw/gateway-client.js";

// OpenClaw 2026.11.6 reports ready before its config reloader runs and answers a
// write in between like this; the reloader applies the persisted file once it starts.
const unclaimedPatch = {
  code: "UNAVAILABLE",
  message:
    "config.patch persisted but was not applied to the active Gateway (unclaimed); run config.get, then use config.apply to reapply the saved config or restart the Gateway",
  details: { persistedConfig: { hash: "h2", config: { secret: "never kept" } } },
};
const unclaimedAgent = {
  code: "UNAVAILABLE",
  message:
    "Agent configuration was saved but its application to the active Gateway was not confirmed (unclaimed); run config.get, then apply the saved config or restart the Gateway.",
};
const refusal = (frame) =>
  Object.assign(Error("unavailable"), {
    code: frame.code,
    answered: true,
    ...persistedWrite(frame),
  });

test("only a persisted, not applied write keeps its outcome and hash", () => {
  assert.deepEqual(persistedWrite(unclaimedPatch), {
    persisted: { outcome: "unclaimed", hash: "h2" },
  });
  assert.deepEqual(persistedWrite(unclaimedAgent), {
    persisted: { outcome: "unclaimed" },
  });
  assert.deepEqual(
    persistedWrite({
      ...unclaimedPatch,
      message:
        "config.patch persisted and was accepted for restart; wait for the Gateway to restart",
    }),
    {},
  );
  assert.deepEqual(persistedWrite({ ...unclaimedPatch, code: "INVALID_REQUEST" }), {});
});

// A Gateway whose config.get answers `gets` in turn (the last one again and again)
// and that refuses every write as unclaimed.
function gateway(gets, agents = []) {
  const calls = [];
  const queue = [...gets];
  return {
    calls,
    async call(method) {
      calls.push(method);
      if (method === "agents.list") return { agents };
      if (method === "config.get") return queue.length > 1 ? queue.shift() : queue[0];
      if (method === "config.patch") throw refusal(unclaimedPatch);
      if (method.startsWith("agents.")) throw refusal(unclaimedAgent);
      throw Error(`unexpected ${method}`);
    },
  };
}
const pending = { hash: "h2", configRevisionHash: "r2", appliedConfigHash: "r1" };
const applied = { hash: "h2", configRevisionHash: "r2", appliedConfigHash: "r2" };
const initial = { hash: "h1", configRevisionHash: "r1", appliedConfigHash: "r1" };

test("an unclaimed patch succeeds once the Gateway applied the written file", async () => {
  const g = gateway([{ ...initial, config: {} }, pending, applied]);
  const result = await patchConfig(g, () => ({ patch: { cron: { enabled: true } } }));
  assert.equal(result.hash, "h1", "patchConfig answers the base it built on");
  assert.deepEqual(
    g.calls.filter((m) => m !== "agents.list"),
    ["config.get", "config.patch", "config.get", "config.get"],
  );
});

test("an unclaimed write the Gateway never applies stays an error", async () => {
  const g = gateway([initial, pending]);
  let clock = 0;
  await assert.rejects(
    configWrite(g, (call) => call("config.patch", { raw: "{}" }), {
      settleMs: 1000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    }),
    (error) => error.code === "UNAVAILABLE" && error.persisted.outcome === "unclaimed",
  );
});

test("an unclaimed agents.create answers the agent it made once applied", async () => {
  const made = gateway([initial, pending, applied], [{ id: "ap-1" }]);
  assert.deepEqual(
    await configWrite(made, (call) => call("agents.create", { name: "ap-1" })),
    { ok: true, agentId: "ap-1" },
  );
  const missing = gateway([initial, applied], []);
  await assert.rejects(
    configWrite(missing, (call) => call("agents.create", { name: "ap-1" })),
    (error) => error.persisted.outcome === "unclaimed",
  );
  const updated = gateway([initial, applied]);
  assert.deepEqual(
    await configWrite(updated, (call) => call("agents.update", { agentId: "ap-1" })),
    { ok: true },
  );
});
