import test from "node:test";
import assert from "node:assert/strict";
import { retryingCall } from "../../server/features/assistants/retryable-calls.js";

const refusal = (fields) =>
  Object.assign(new Error("refused"), { code: "UNAVAILABLE", ...fields });

test("a retryable answer is asked again after the wait it names, capped", async () => {
  const waits = [];
  let calls = 0;
  const result = await retryingCall(
    async () => {
      if (++calls < 3)
        throw refusal({ answered: true, retryable: true, retryAfterMs: 9000 });
      return "done";
    },
    { sleep: async (ms) => waits.push(ms) },
  );
  assert.equal(result, "done");
  assert.deepEqual(waits, [2000, 2000]);
});

test("other failures throw at once; retries and the deadline bound the rest", async () => {
  const sleep = async () => {};
  for (const fields of [
    { answered: true, retryable: false },
    { answered: true },
    { retryable: true },
  ]) {
    let calls = 0;
    await assert.rejects(
      retryingCall(
        async () => {
          calls++;
          throw refusal(fields);
        },
        { sleep },
      ),
      { code: "UNAVAILABLE" },
    );
    assert.equal(calls, 1, JSON.stringify(fields));
  }
  let calls = 0;
  const always = async () => {
    calls++;
    throw refusal({ answered: true, retryable: true, retryAfterMs: 10 });
  };
  await assert.rejects(retryingCall(always, { sleep, retries: 2 }));
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retryingCall(always, { sleep, now: () => 100, deadline: 105 }));
  assert.equal(calls, 1);
});

test("a refusal without a usable wait waits the minimum, never a tight loop", async () => {
  for (const retryAfterMs of [undefined, 0, Number.NaN, Infinity, -5]) {
    const waits = [];
    let calls = 0;
    await retryingCall(
      async () => {
        if (++calls < 2) throw refusal({ answered: true, retryable: true, retryAfterMs });
        return "done";
      },
      { sleep: async (ms) => waits.push(ms) },
    );
    assert.deepEqual(waits, [250], String(retryAfterMs));
  }
});

test("a wait that fits the deadline runs; the next one past it does not", async () => {
  let clock = 0;
  const waits = [];
  let calls = 0;
  await assert.rejects(
    retryingCall(
      async () => {
        calls++;
        throw refusal({ answered: true, retryable: true, retryAfterMs: 1000 });
      },
      {
        now: () => clock,
        deadline: 1500,
        sleep: async (ms) => {
          waits.push(ms);
          clock += ms;
        },
      },
    ),
    { code: "UNAVAILABLE" },
  );
  assert.deepEqual(waits, [1000]);
  assert.equal(calls, 2);
});
