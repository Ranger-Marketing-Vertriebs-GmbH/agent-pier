import test from "node:test";
import assert from "node:assert/strict";

const native = await import("../../server/features/pipelines/native-command.js").catch(
  () => ({}),
);
const events = await import("../../server/features/pipelines/native-events.js").catch(
  () => ({}),
);
const launch = {
  command: "/fixture/cli",
  args: ["--model", "pinned"],
  env: { KEEP: "yes" },
};

for (const [tool, mode, prefix, resume] of [
  ["codex", "never", ["exec", "--json"], ["resume", "native-42", "-"]],
  [
    "claude",
    "acceptEdits",
    ["--print", "--output-format", "stream-json", "--verbose"],
    ["--resume", "native-42"],
  ],
  ["opencode", "auto", ["run", "--format", "json"], ["--session", "native-42"]],
]) {
  test(`${tool} headless turn preserves provider pins and resumes explicit history`, () => {
    assert.equal(typeof native.nativeCommand, "function");
    const result = native.nativeCommand({
      tool,
      launch,
      mode,
      sessionId: "first-42",
      resumeNativeId: "native-42",
      headless: true,
    });
    assert.deepEqual(result.args.slice(0, prefix.length), prefix);
    assert.equal(result.args.includes("pinned"), true);
    for (const part of resume) assert.equal(result.args.includes(part), true);
    assert.equal(result.args.includes("--continue"), false);
    assert.equal(result.env.KEEP, "yes");
    assert.deepEqual(launch.args, ["--model", "pinned"]);
  });
}
test("native permission domains reject silent cross-CLI escalation", () => {
  assert.equal(typeof native.nativeCommand, "function");
  for (const [tool, mode] of [
    ["codex", "auto"],
    ["claude", "never"],
    ["opencode", "bypassPermissions"],
  ])
    assert.throws(
      () => native.nativeCommand({ tool, mode, launch, sessionId: "s", headless: true }),
      /permission/i,
    );
});
test("Codex usage and native identity come from structured events", () => {
  assert.equal(typeof events.reduceNativeEvent, "function");
  let state = events.reduceNativeEvent(
    "codex",
    {},
    { type: "thread.started", thread_id: "thread-1" },
  );
  state = events.reduceNativeEvent("codex", state, {
    type: "turn.completed",
    usage: { input_tokens: 10, cached_input_tokens: 6, output_tokens: 4 },
  });
  assert.equal(state.nativeId, "thread-1");
  assert.equal(state.result, "completed");
  assert.deepEqual(state.usage, { inputTokens: 10, outputTokens: 4 });
});
test("OpenCode tool steps cannot finish a turn and errors cannot be overwritten", () => {
  assert.equal(typeof events.reduceNativeEvent, "function");
  let state = events.reduceNativeEvent(
    "opencode",
    {},
    {
      type: "step_finish",
      sessionID: "ses_one",
      part: { reason: "tool-calls", tokens: { input: 10, output: 2 } },
    },
  );
  assert.equal(state.result, undefined);
  state = events.reduceNativeEvent("opencode", state, {
    type: "error",
    error: { data: { message: "rate limited", statusCode: 429 } },
  });
  state = events.reduceNativeEvent("opencode", state, {
    type: "step_finish",
    part: { reason: "stop", tokens: { input: 11, output: 3 } },
  });
  assert.equal(state.result, "failed");
  assert.equal(state.nativeId, "ses_one");
  assert.equal(state.error, "rate limited");
});
test("Claude result errors override a zero process exit without invented usage", () => {
  assert.equal(typeof events.reduceNativeEvent, "function");
  const state = events.reduceNativeEvent(
    "claude",
    {},
    {
      type: "result",
      session_id: "c-1",
      is_error: true,
      subtype: "error_max_turns",
      errors: ["turn limit"],
    },
  );
  assert.equal(state.result, "failed");
  assert.equal(state.nativeId, "c-1");
  assert.equal(state.usage, undefined);
});
