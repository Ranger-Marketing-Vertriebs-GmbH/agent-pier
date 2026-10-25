import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  failureMessage,
  failureMessageLimit,
  failureReasons,
  lastRunFailure,
  runEntry,
  runFailure,
} from "../../server/features/assistants/routine-failures.js";

const reason = (error, errorReason) =>
  runFailure({ status: "error", error, errorReason })?.reason;

test("OpenClaw's run errors map to a readable cause", () => {
  // Messages OpenClaw 2026.10.7 records for a cron run (dist cron modules).
  assert.equal(reason("cron: job interrupted by gateway restart"), "gateway-restart");
  assert.equal(
    reason("cron: active runs did not drain before shutdown timeout"),
    "gateway-restart",
  );
  assert.equal(
    reason(
      "Cron receipt authority is unavailable; wait for Gateway settlement or restart.",
    ),
    "gateway-restart",
  );
  assert.equal(
    reason("cron: job interrupted because owner is unavailable"),
    "gateway-stopped",
  );
  assert.equal(
    reason("cron: queued run interrupted because owner is unavailable"),
    "gateway-stopped",
  );
  assert.equal(
    reason('Agent "network-architect" no longer exists in configuration'),
    "agent-unavailable",
  );
  assert.equal(reason('unknown agentId "ops"'), "agent-unavailable");
  assert.equal(reason("cron: job execution timed out"), "timeout");
  assert.equal(
    reason("cron: isolated agent run stalled before execution start"),
    "timeout",
  );
  // OpenClaw's failover reason decides when it has one.
  assert.equal(reason("Request failed", "rate_limit"), "model");
  assert.equal(reason("Request failed", "auth"), "model");
  assert.equal(reason("LLM request timed out.", "timeout"), "timeout");
  assert.equal(reason("500 Internal Server Error"), "model");
  assert.equal(reason("429 Too Many Requests"), "model");
  assert.equal(reason("cron: webhook delivery failed"), "delivery");
  // A Gateway restart wins over a failover reason inferred from its words.
  assert.equal(
    reason("cron: job interrupted by gateway restart", "timeout"),
    "gateway-restart",
  );
  assert.equal(reason("Something unexpected"), "other");
  assert.equal(reason(undefined), "other");
  for (const r of ["gateway-restart", "timeout", "model", "other"])
    assert.ok(failureReasons.includes(r));
});

test("only a failed run has a failure; one without a message has only its cause", () => {
  assert.equal(runFailure({ status: "ok", error: "x" }), null);
  assert.equal(runFailure({ status: "skipped" }), null);
  assert.equal(runFailure(), null);
  assert.deepEqual(runFailure({ status: "error" }), { reason: "other" });
  assert.deepEqual(runFailure({ status: "error", error: "  " }), { reason: "other" });
});

test("the message hides secrets and stays bounded", () => {
  const key = `sk-${"a".repeat(40)}`;
  const text = [
    `401 Unauthorized: Incorrect API key provided: ${key}.`,
    "Authorization: Bearer abcdefghijklmnop123",
    "GET https://user:hunter2@api.example/v1?api_key=SECRETVALUE&x=1",
    "Bearer qwertyuiopasdfgh",
    '{"token":"tok-123456"}',
  ].join("\n");
  const message = failureMessage(text);
  for (const secret of [
    key,
    "abcdefghijklmnop123",
    "hunter2",
    "SECRETVALUE",
    "qwertyuiopasdfgh",
    "tok-123456",
  ])
    assert.doesNotMatch(message, new RegExp(secret), secret);
  assert.match(message, /401 Unauthorized/);
  assert.match(message, /x=1/);
  const long = failureMessage(`cron: job failed: ${"é".repeat(2000)}`);
  assert.equal(Array.from(long).length, failureMessageLimit);
  assert.ok(long.endsWith("…"));
  assert.equal(failureMessage("a\u0000b\u001bc"), "a b c");
  assert.equal(failureMessage(42), "");
});

test("no bounded message ever reveals a known token or exceeds the limit", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 600 }), fc.string({ maxLength: 600 }), (a, b) => {
      const token = `ghp_${"Z".repeat(36)}`;
      const message = failureMessage(`${a} ${token} ${b}`);
      assert.ok(Array.from(message).length <= failureMessageLimit);
      assert.ok(!message.includes(token));
    }),
  );
});

test("a job's state and a run entry carry the cause of their failure", () => {
  assert.equal(lastRunFailure(undefined), null);
  assert.equal(lastRunFailure({ lastRunStatus: "ok" }), null);
  assert.deepEqual(
    lastRunFailure({
      lastRunStatus: "error",
      lastError: "cron: job interrupted by gateway restart",
      lastRunAtMs: 1000,
      consecutiveErrors: 2,
    }),
    {
      reason: "gateway-restart",
      message: "cron: job interrupted by gateway restart",
      atMs: 1000,
      consecutive: 2,
    },
  );
  assert.deepEqual(
    runEntry({
      runAtMs: 5,
      status: "error",
      completionStatus: "failed",
      deliveryStatus: "not-delivered",
      durationMs: 1200,
      error: "LLM request failed",
      errorReason: "server_error",
      summary: "never shown",
    }),
    {
      runAtMs: 5,
      status: "error",
      completionStatus: "failed",
      deliveryStatus: "not-delivered",
      durationMs: 1200,
      failure: { reason: "model", message: "LLM request failed" },
    },
  );
  assert.deepEqual(runEntry({ runAtMs: 6, status: "ok" }), {
    runAtMs: 6,
    status: "ok",
    completionStatus: undefined,
    deliveryStatus: undefined,
  });
});
