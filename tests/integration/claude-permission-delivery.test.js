import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { terminalNoticeMs } from "../../server/features/requests/request-broker.js";
import { claudeHookTimeoutSeconds } from "../../server/features/requests/claude-runtime.js";
import {
  subagentSession,
  subagentToolResult,
  subagentToolUse,
} from "../fixtures/requests/claude-subagent-permission.js";
import {
  fixture,
  hook,
  pending,
  state,
  toolResult,
  toolUse,
  transcribed,
  turns,
  waitFor,
  workflow,
} from "../helpers/claude-hook-fixture.js";

test("a Claude permission keeps waiting in chat past the old 590 s fallback", async (t) => {
  const f = await fixture(t);
  const payload = await transcribed(f);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // No timeout override: this is the production lifetime.
  const run = hook(f, payload);
  const request = await pending(f);
  assert.equal(request.kind, "permission");
  await turns();
  t.mock.timers.tick(590_000 + 5_000);
  await turns();
  assert.equal(run.ended(), false, "the hook must still own the permission");
  const [still] = (await state(f)).requests;
  assert.equal(still?.id, request.id);
  assert.equal(still.status, "pending");
  assert.equal(
    f.events.some((event) => event.action === "request.expired"),
    false,
    "the chat request must not silently expire",
  );
  // It lives as long as a question: until shortly before Claude's hook timeout.
  t.mock.timers.tick(claudeHookTimeoutSeconds * 1000 - 10_000 - 595_000);
  await run.done;
  assert.equal(run.output(), "", "an expired hook leaves the decision to Claude");
  const after = await waitFor(
    () => state(f),
    (value) => !value.requests.length && value.notice,
  );
  assert.deepEqual(after.notice, { id: request.id, reason: "terminal" });
});

for (const [name, extra] of [
  ["the main agent", {}],
  // A subagent whose transcript never shows the call (an unknown layout).
  ["a subagent", { agent_id: "a0f1e2d3c4b5a6978", agent_type: "general-purpose" }],
  // An unsafe agent id is never joined into a path; the session transcript stays.
  ["an unsafe agent id", { agent_id: "../x" }],
])
  test(`a permission of ${name} found in no transcript waits for the hook's lifetime`, async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    // No transcript shows the call: chat keeps it as long as any other request.
    const run = hook(f, {
      ...workflow,
      ...extra,
      transcript_path: path.join(f.root, "missing.jsonl"),
    });
    const request = await pending(f);
    await turns();
    t.mock.timers.tick(590_000 + 5_000);
    await turns();
    assert.equal(run.ended(), false, "no bounded wait cuts an unmatched card off");
    t.mock.timers.tick(claudeHookTimeoutSeconds * 1000 - 10_000 - 595_000);
    await run.done;
    assert.equal(run.output(), "");
    const after = await waitFor(
      () => state(f),
      (value) => !value.requests.length && value.notice,
    );
    assert.deepEqual(after.notice, { id: request.id, reason: "terminal" });
    const ended = f.events.find((event) => event.action === "request.expired");
    assert.equal(ended.details.cause, "timeout");
  });

test("a subagent permission keeps waiting in chat past 590 s", async (t) => {
  const f = await fixture(t);
  // Claude records a subagent's call only in the subagent's own transcript.
  const { payload } = await subagentSession(f.root);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = hook(f, payload);
  const request = await pending(f);
  assert.equal(request.subject.agent, "general-purpose");
  await turns();
  t.mock.timers.tick(590_000 + 5_000);
  await turns();
  assert.equal(run.ended(), false, "the hook must still own the subagent's permission");
  const [still] = (await state(f)).requests;
  assert.equal(still?.id, request.id);
  assert.equal(still.status, "pending");
  assert.equal(
    f.events.some((event) => event.action === "request.expired"),
    false,
  );
  t.mock.timers.tick(claudeHookTimeoutSeconds * 1000 - 10_000 - 595_000);
  await run.done;
});

test("a session started with --agent watches the session transcript", async (t) => {
  const f = await fixture(t);
  // agent_type without agent_id: the main agent of a custom-agent session asks.
  const payload = { ...(await transcribed(f)), agent_type: "reviewer" };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = hook(f, payload);
  const request = await pending(f);
  assert.equal(request.subject.agent, undefined, "the main agent is not labelled");
  await turns();
  t.mock.timers.tick(590_000 + 5_000);
  await turns();
  assert.equal(run.ended(), false, "the session transcript match lifts the bound");
  await fs.appendFile(payload.transcript_path, toolResult());
  for (let i = 0; i < 4 && !run.ended(); i++) {
    t.mock.timers.tick(500);
    await turns();
  }
  await run.done;
  assert.equal(run.output(), "");
  const after = await waitFor(
    () => state(f),
    (value) => !value.requests.length,
  );
  assert.equal(after.notice, undefined, "a terminal decision leaves no notice");
});

test("a subagent transcript written after the hook started still lifts the bound", async (t) => {
  const f = await fixture(t);
  const { payload, file } = await subagentSession(f.root, { write: false });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = hook(f, payload);
  await pending(f);
  await turns();
  await fs.writeFile(file, subagentToolUse(payload));
  // The watcher polls every 500 ms until the file appears.
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(500);
    await turns();
  }
  t.mock.timers.tick(590_000);
  await turns();
  assert.equal(run.ended(), false);
  t.mock.timers.tick(claudeHookTimeoutSeconds * 1000);
  await run.done;
});

test("a subagent call decided in Claude's own dialog withdraws the chat request", async (t) => {
  const f = await fixture(t);
  const { payload, file } = await subagentSession(f.root);
  const run = hook(f, payload, { timeout: 10_000 });
  const request = await pending(f);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(run.ended(), false);
  // Approved in the terminal: the subagent ran the tool and recorded its result.
  await fs.appendFile(file, subagentToolResult());
  await run.done;
  assert.equal(run.output(), "", "the hook never decides after Claude did");
  const after = await waitFor(
    () => state(f),
    (value) => !value.requests.length,
  );
  assert.equal(after.notice, undefined);
  assert.equal(
    f.events.find(
      (event) => event.action === "request.expired" && event.resourceId === request.id,
    )?.details.cause,
    "native",
  );
});

test("a subagent's identical call in the session transcript does not settle its request", async (t) => {
  const f = await fixture(t);
  const { payload, transcript, file } = await subagentSession(f.root);
  // The main agent may run the same command; only the subagent's result counts.
  await fs.appendFile(transcript, toolUse(payload, "toolu_main"));
  const run = hook(f, payload, { timeout: 10_000 });
  await pending(f);
  await fs.appendFile(transcript, toolResult("toolu_main"));
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(run.ended(), false);
  await fs.appendFile(file, subagentToolResult());
  await run.done;
});

test("a decision in Claude's own dialog withdraws the chat request without a notice", async (t) => {
  const f = await fixture(t);
  const payload = await transcribed(f);
  // An older, already answered identical call must not count as this decision.
  await fs.writeFile(
    payload.transcript_path,
    toolUse(payload, "toolu_old") +
      toolResult("toolu_old") +
      (await fs.readFile(payload.transcript_path, "utf8")),
  );
  const run = hook(f, payload, { timeout: 10_000 });
  const request = await pending(f);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(run.ended(), false, "an unrelated earlier result must not settle it");
  // Approved in the terminal: Claude ran the tool and recorded its result.
  await fs.appendFile(payload.transcript_path, toolResult());
  await run.done;
  assert.equal(run.output(), "", "the hook never decides after Claude did");
  const after = await waitFor(
    () => state(f),
    (value) => !value.requests.length,
  );
  assert.equal(after.notice, undefined);
  assert.ok(
    f.events.some(
      (event) => event.action === "request.expired" && event.resourceId === request.id,
    ),
  );
});

test("a Claude permission survives broker restarts and delivers exactly once", async (t) => {
  const f = await fixture(t);
  const run = hook(
    f,
    {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
    { timeout: 10_000 },
  );
  const old = await pending(f);
  for (let i = 0; i < 2; i++) {
    await f.restart();
    const current = await pending(f);
    assert.equal(current.id, old.id);
    assert.equal(current.status, "pending");
  }
  assert.equal(run.ended(), false);
  await f.broker.answer("session", old.id, { expectedRevision: 1, choice: "allow" });
  await run.done;
  assert.deepEqual(JSON.parse(run.output()).hookSpecificOutput, {
    hookEventName: "PermissionRequest",
    decision: { behavior: "allow" },
  });
  assert.equal(f.events.filter((event) => event.action === "request.created").length, 1);
  assert.equal(f.events.filter((event) => event.action === "request.answered").length, 1);
  assert.equal((await state(f)).notice, undefined, "a chat decision leaves no notice");
});

test("a permission handed to the terminal leaves a notice until the next request", async (t) => {
  const f = await fixture(t);
  const first = hook(f, workflow, { timeout: 10_000 });
  const request = await pending(f);
  await f.broker.handoff("session", request.id, { expectedRevision: 1 });
  await first.done;
  assert.equal(first.output(), "", "handoff leaves the decision to Claude's own dialog");
  assert.deepEqual((await state(f)).notice, { id: request.id, reason: "terminal" });
  const second = hook(
    f,
    {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
    { timeout: 10_000 },
  );
  const next = await pending(f);
  assert.equal((await state(f)).notice, undefined, "a newer request replaces the notice");
  await f.broker.answer("session", next.id, { expectedRevision: 1, choice: "deny" });
  await second.done;
});

test("a terminal notice fades after its time-to-live or once chat moves on", async (t) => {
  const f = await fixture(t);
  for (const clear of [
    () => {
      f.broker.notices.records.get("session").at -= terminalNoticeMs;
    },
    () => f.broker.clearNotice("session"),
  ]) {
    const run = hook(f, workflow, { timeout: 10_000 });
    const request = await pending(f);
    await f.broker.handoff("session", request.id, { expectedRevision: 1 });
    await run.done;
    assert.equal((await state(f)).notice?.id, request.id);
    clear();
    assert.equal((await state(f)).notice, undefined);
  }
});

test("a released Claude question leaves no approval notice", async (t) => {
  const f = await fixture(t);
  const run = hook(
    f,
    {
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which?", options: [{ label: "A" }] }] },
    },
    { timeout: 10_000 },
  );
  const request = await pending(f);
  await f.broker.handoff("session", request.id, { expectedRevision: 1 });
  await run.done;
  assert.equal((await state(f)).notice, undefined);
});

test("Always allow from chat returns Claude's rule for the account's user settings", async (t) => {
  const f = await fixture(t);
  const run = hook(
    f,
    {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    },
    { timeout: 10_000 },
  );
  const request = await pending(f);
  assert.equal(
    request.options.find((option) => option.id === "always")?.description,
    "Bash(npm test:*)",
  );
  await f.broker.answer("session", request.id, { expectedRevision: 1, choice: "always" });
  await run.done;
  assert.deepEqual(JSON.parse(run.output()).hookSpecificOutput.decision, {
    behavior: "allow",
    updatedPermissions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow",
        destination: "userSettings",
      },
    ],
  });
});

test("a Claude plan reaches chat in full and keep planning stops Claude", async (t) => {
  const f = await fixture(t);
  const plan = "# Plan\n\n" + "- step\n".repeat(6000);
  const run = hook(
    f,
    {
      hook_event_name: "PermissionRequest",
      tool_name: "ExitPlanMode",
      tool_input: { plan },
    },
    { timeout: 10_000 },
  );
  const request = await pending(f);
  assert.equal(request.subject.plan, plan);
  await f.broker.answer("session", request.id, { expectedRevision: 1, choice: "keep" });
  await run.done;
  const { decision } = JSON.parse(run.output()).hookSpecificOutput;
  assert.equal(decision.behavior, "deny");
  assert.equal(decision.interrupt, true);
});
