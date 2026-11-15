import test from "node:test";
import assert from "node:assert/strict";
import { GatewayClient } from "../../server/features/assistants/runtimes/openclaw/gateway-client.js";
import { repeating } from "../../server/features/assistants/runtimes/openclaw/gateway-retry.js";
import { gatewayFixture } from "../helpers/assistant-gateway-fixture.js";

// As OpenClaw 2026.11.3 refuses any method while it drains for a restart.
const draining = (method) => ({
  code: "UNAVAILABLE",
  message: `${method} unavailable during gateway restart`,
  retryable: true,
  retryAfterMs: 1,
  details: { method, reason: "gateway-restarting", phase: "draining" },
});
const superseded = {
  code: "UNAVAILABLE",
  message: "prepared model runtime catalog generation was superseded",
  retryable: true,
};
// Retryable, but OpenClaw may have acted (a logout that removed the profiles).
const afterEffect = {
  code: "UNAVAILABLE",
  message: "Agent ap-1 database inspection is pending",
  retryable: true,
  retryAfterMs: 1,
  details: { code: "agent-database-inspection-pending", agentId: "ap-1" },
};

async function connected(t, refusals) {
  const fixture = await gatewayFixture({ refusals });
  t.after(() => fixture.close());
  const client = new GatewayClient({
    url: fixture.url,
    certPath: fixture.certPath,
    token: "fixture",
  });
  t.after(() => client.close());
  await client.connect();
  const sent = (method) => fixture.calls.filter((c) => c.method === method).length;
  return { client, sent };
}

test("a refusal before dispatch is sent again for any method; a read's too", async (t) => {
  const { client, sent } = await connected(t, {
    "sessions.send": [draining("sessions.send"), draining("sessions.send")],
    "config.patch": [
      { ...draining("config.patch"), details: { mutationAccepted: false } },
    ],
    "models.list": [superseded],
  });
  assert.deepEqual(await client.call("sessions.send", {}), { value: 42 });
  assert.equal(sent("sessions.send"), 3);
  assert.deepEqual(await client.call("config.patch", {}), { value: 42 });
  assert.equal(sent("config.patch"), 2);
  assert.deepEqual(await client.call("models.list", {}), { value: 42 });
  assert.equal(sent("models.list"), 2);
});

test("a retryable refusal after which OpenClaw may have acted is not repeated", async (t) => {
  const { client, sent } = await connected(t, {
    "models.authLogout": [afterEffect],
    "sessions.send": [superseded],
    "config.patch": [
      {
        code: "UNAVAILABLE",
        message: "rate limit exceeded for config.patch; retry after 46s",
        retryable: true,
        retryAfterMs: 45559,
        details: { method: "config.patch", limit: "30 per 60s" },
      },
    ],
  });
  await assert.rejects(client.call("models.authLogout", {}), { code: "UNAVAILABLE" });
  assert.equal(sent("models.authLogout"), 1);
  await assert.rejects(client.call("sessions.send", {}), { code: "UNAVAILABLE" });
  assert.equal(sent("sessions.send"), 1);
  // The control-plane budget keeps its own wait in live-patch.js.
  await assert.rejects(client.call("config.patch", {}), { retryAfterMs: 45559 });
  assert.equal(sent("config.patch"), 1);
});

test("repeats wait the minimum or what is asked, capped, within the caller's timeout", async () => {
  const refused = (fields) =>
    Object.assign(new Error("refused"), {
      code: "UNAVAILABLE",
      answered: true,
      retryable: true,
      beforeDispatch: true,
      ...fields,
    });
  for (const [retryAfterMs, wait] of [
    [undefined, 250],
    [Number.NaN, 250],
    [Infinity, 250],
    [-5, 250],
    [1000, 1000],
    [9000, 2000],
  ]) {
    const waits = [];
    let calls = 0;
    const result = await repeating(
      "x",
      async () => {
        if (++calls < 2) throw refused({ retryAfterMs });
        return "done";
      },
      { timeoutMs: 60000, sleep: async (ms) => waits.push(ms) },
    );
    assert.equal(result, "done");
    assert.deepEqual(waits, [wait], String(retryAfterMs));
  }
  // A first wait that fits, then one past the timeout; each attempt gets what is left.
  let clock = 0;
  const timeouts = [];
  await assert.rejects(
    repeating(
      "x",
      async (timeoutMs) => {
        timeouts.push(timeoutMs);
        throw refused({ retryAfterMs: 1000 });
      },
      {
        timeoutMs: 1500,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    ),
    { code: "UNAVAILABLE" },
  );
  assert.deepEqual(timeouts, [1500, 500]);
  // At most `retries` repeats.
  let calls = 0;
  await assert.rejects(
    repeating(
      "x",
      async () => {
        calls++;
        throw refused({});
      },
      { timeoutMs: 60000, retries: 3, sleep: async () => {} },
    ),
  );
  assert.equal(calls, 4);
  // A local failure (not answered) is never repeated.
  calls = 0;
  await assert.rejects(
    repeating(
      "models.list",
      async () => {
        calls++;
        throw Object.assign(new Error("local"), { retryable: true });
      },
      { timeoutMs: 60000, sleep: async () => {} },
    ),
  );
  assert.equal(calls, 1);
});
