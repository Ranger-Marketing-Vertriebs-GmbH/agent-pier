import test from "node:test";
import assert from "node:assert/strict";

const unavailable = (error) => error.code === "UNAVAILABLE" && error.status === 503;
const day = /^\d{4}-\d{2}-\d{2}$/;
const whole = (value) => Number.isSafeInteger(value) && value >= 0;

/** Whether `usage` has the port's tokens, cost and pending flag. */
export function assertUsage(usage, label = "usage") {
  for (const part of ["input", "output", "cacheRead", "cacheWrite", "total"])
    assert.ok(whole(usage.tokens[part]), `${label} tokens.${part}`);
  assert.equal(typeof usage.pending, "boolean", label);
  // A cost is an amount in a currency, or null: never a bare or invented number.
  if (usage.cost !== null) {
    assert.ok(Number.isFinite(usage.cost.amount) && usage.cost.amount >= 0, label);
    assert.match(usage.cost.currency, /^[A-Z]{3}$/, label);
    assert.equal(typeof usage.cost.partial, "boolean", label);
  }
}

/**
 * The usage reads of the runtime port contract (runtime-port-contract.js):
 * sessions.usage and agents.usage of a runtime with the `usage` capability, a view
 * bound to a replaced connection, and both while the runtime is unreachable. A
 * runtime without the capability rejects both with code UNSUPPORTED.
 */
export function usageContract(name, make) {
  const agentId = "ap-1";
  const now = new Date(2026, 10, 27, 12).getTime();

  test(`${name}: a session's usage counts its turns' tokens and names a cost or none`, async (t) => {
    const runtime = await make({});
    const { sessions } = runtime;
    if (!runtime.capabilities().usage.available) {
      await assert.rejects(sessions.usage({ key: "k" }), { code: "UNSUPPORTED" });
      return t.skip("no usage");
    }
    const { key } = await sessions.create({ agentId, label: "usage" });
    const before = await sessions.usage({ key });
    assertUsage(before, "before");
    assert.equal(before.tokens.total, 0);
    assert.equal(before.cost, null);
    const { runId } = await sessions.send({
      key,
      turn: { message: "hello" },
      idempotencyKey: "usage-run",
    });
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await sessions.wait({ runId, waitMs: 1000 })).status, "ok");
    const after = await sessions.usage({ key });
    assertUsage(after, "after");
    assert.ok(after.tokens.total > 0);
    assert.equal(
      after.tokens.total,
      after.tokens.input +
        after.tokens.output +
        after.tokens.cacheRead +
        after.tokens.cacheWrite,
    );
    // The context of its last call, or null while unknown.
    if (after.context !== null) {
      assert.ok(whole(after.context.used) && after.context.used > 0);
      assert.ok(after.context.limit === null || whole(after.context.limit));
    }
  });

  test(`${name}: an agent's usage covers the last days up to the day of now`, async (t) => {
    const runtime = await make({});
    const { agents } = runtime;
    if (!runtime.capabilities().usage.available) {
      await assert.rejects(agents.usage({ agentId, days: 7, now }), {
        code: "UNSUPPORTED",
      });
      return t.skip("no usage");
    }
    const usage = await agents.usage({ agentId, days: 7, now });
    assertUsage(usage);
    assert.match(usage.from, day);
    assert.equal(usage.from, "2026-11-21");
    assert.equal(usage.to, "2026-11-27");
    assert.deepEqual(
      usage.daily.map((entry) => entry.date),
      [
        "2026-11-21",
        "2026-11-22",
        "2026-11-23",
        "2026-11-24",
        "2026-11-25",
        "2026-11-26",
        "2026-11-27",
      ],
    );
    for (const entry of usage.daily) assert.ok(whole(entry.tokens), entry.date);
    const today = await agents.usage({ agentId, days: 1, now });
    assert.equal(today.from, today.to);
    assert.equal(today.daily.length, 1);
    // A range that is no whole number of days from 1 to 366 is refused.
    for (const days of [0, 367, 1.5])
      await assert.rejects(agents.usage({ agentId, days, now }));
  });

  test(`${name}: usage reads reject on a replaced connection and while unreachable`, async (t) => {
    const runtime = await make({});
    if (!runtime.capabilities().usage.available) return t.skip("no usage");
    const connection = runtime.host.connection();
    const sessions = runtime.sessions.on(connection);
    const agents = runtime.agents.on(connection);
    assertUsage(await agents.usage({ agentId, days: 1, now }));
    await runtime.host.restart();
    await assert.rejects(agents.usage({ agentId, days: 1, now }), unavailable);
    await assert.rejects(sessions.usage({ key: "k" }), unavailable);
    const down = await make({ unreachable: true });
    for (const pending of [
      down.sessions.usage({ key: "k" }),
      down.agents.usage({ agentId, days: 1, now }),
    ]) {
      // A rejection, never a synchronous throw: callers await it inside try/catch.
      assert.ok(pending instanceof Promise);
      await assert.rejects(pending);
    }
  });
}

const pad = (value) => String(value).padStart(2, "0");
const dayOf = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * The fake runtime's usage: every turn sent in a session counts 10 input and 5
 * output tokens, without a price. `turnsOf(key)` and `turnsOfAgent(agentId)` answer
 * the turns sent so far.
 */
export function fakeUsage({ turnsOf, turnsOfAgent }) {
  const counted = (turns) => ({
    tokens: {
      input: turns * 10,
      output: turns * 5,
      cacheRead: 0,
      cacheWrite: 0,
      total: turns * 15,
    },
    cost: null,
    pending: false,
  });
  return {
    session: ({ key }) => {
      const turns = turnsOf(key);
      return {
        ...counted(turns),
        context: turns ? { used: turns * 10, limit: null } : null,
      };
    },
    agent: ({ agentId, days, now = Date.now() }) => {
      if (!Number.isInteger(days) || days < 1 || days > 366)
        throw new TypeError("A usage range is 1 to 366 days.");
      const end = new Date(now);
      const daily = Array.from({ length: days }, (_, index) => ({
        date: dayOf(
          new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1 - index)),
        ),
        tokens: 0,
      }));
      const usage = counted(turnsOfAgent(agentId));
      daily.at(-1).tokens = usage.tokens.total;
      return { from: daily[0].date, to: daily.at(-1).date, ...usage, daily };
    },
  };
}
