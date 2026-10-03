import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  RequestBroker,
  terminalNoticeMs,
} from "../../server/features/requests/request-broker.js";
import { runClaudeHook } from "../../server/features/requests/claude-hook.js";
import { claudeHookTimeoutSeconds } from "../../server/features/requests/claude-runtime.js";

const workflow = {
  hook_event_name: "PermissionRequest",
  tool_name: "Workflow",
  tool_input: {
    script:
      "export const meta = { name: 'nightly-review', description: 'Review open PRs' };\n",
  },
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-claude-permission-"));
  const session = {
    id: "session",
    tool: "claude",
    accountId: "account",
    status: "running",
    nativeRequests: { enabled: true },
  };
  const events = [];
  const config = {
    dataDir: root,
    sessions: { get: async () => session },
    onEvent: (event) => events.push(event),
  };
  let broker = new RequestBroker(config);
  const launch = await broker.prepare({
    id: session.id,
    account: { id: session.accountId, tool: "claude" },
    cwd: root,
    launch: { command: "claude", args: [], env: {} },
  });
  t.after(async () => {
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    launch,
    events,
    get broker() {
      return broker;
    },
    async restart() {
      await broker.close();
      broker = new RequestBroker(config);
      await broker.ready;
    },
  };
}
function hook(f, payload = workflow, options = {}) {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written += chunk;
      callback();
    },
  });
  const input = Readable.from([JSON.stringify(payload)]);
  let ended = false;
  const done = runClaudeHook({ input, output, env: f.launch.env, ...options }).then(
    () => {
      ended = true;
    },
  );
  return { done, output: () => written, ended: () => ended };
}
// Polls through I/O turns only, so it also works while setTimeout is mocked.
async function waitFor(read, predicate) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error("Claude permission observation timed out");
}
const turns = async (count = 50) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};
// Claude records the tool call in its transcript before asking for approval.
const toolUse = (payload, id = "toolu_probe") =>
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id, name: payload.tool_name, input: payload.tool_input },
      ],
    },
  }) + "\n";
const toolResult = (id = "toolu_probe") =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
  }) + "\n";
async function transcribed(f, payload = workflow) {
  const file = path.join(f.root, "transcript.jsonl");
  await fs.writeFile(
    file,
    '{"type":"user","message":{"content":"Go"}}\n' + toolUse(payload),
  );
  return { ...payload, transcript_path: file };
}
const state = (f) => f.broker.list("session");
const pending = (f) =>
  waitFor(
    () => state(f),
    (value) => value.requests.length === 1,
  ).then((value) => value.requests[0]);

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

test("a permission whose tool call is not in the transcript keeps the bounded wait", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // A terminal approval cannot be observed here, so chat must not hold it for a day.
  const run = hook(f, {
    ...workflow,
    transcript_path: path.join(f.root, "missing.jsonl"),
  });
  const request = await pending(f);
  await turns();
  t.mock.timers.tick(589_000);
  await turns();
  assert.equal(run.ended(), false);
  t.mock.timers.tick(2_000);
  await run.done;
  assert.equal(run.output(), "");
  const after = await waitFor(
    () => state(f),
    (value) => !value.requests.length && value.notice,
  );
  assert.deepEqual(after.notice, { id: request.id, reason: "terminal" });
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
      f.broker.notices.get("session").at -= terminalNoticeMs;
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
