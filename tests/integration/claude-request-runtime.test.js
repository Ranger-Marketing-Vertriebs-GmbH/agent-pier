import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";

const question = {
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [
      {
        question: "Which destination?",
        options: [{ label: "Local" }, { label: "Remote" }],
      },
    ],
  },
};
async function waitFor(read, predicate = (state) => state.requests.length) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const state = await read();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Claude bridge observation timed out");
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-claude-runtime-"));
  const session = {
    id: "session",
    tool: "claude",
    accountId: "account",
    status: "running",
    nativeRequests: { enabled: true },
  };
  const events = [],
    children = [],
    channels = [];
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
  const hookFile = path.join(broker.directory, "session.claude/hooks/hooks.json");
  const command = JSON.parse(await fs.readFile(hookFile, "utf8")).hooks.PreToolUse[0]
    .hooks[0].command;
  t.after(async () => {
    for (const channel of channels) channel.close();
    for (const child of children) child.kill();
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    session,
    launch,
    events,
    hookFile,
    command,
    get broker() {
      return broker;
    },
    async restart() {
      await broker.close();
      broker = new RequestBroker(config);
      await broker.ready;
    },
    hook(input = question) {
      // Executes the exact command cached by the native CLI at launch.
      const child = spawn("/bin/sh", ["-c", command], { env: launch.env, cwd: root });
      children.push(child);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      const ended = once(child, "close").then(([code]) => {
        assert.equal(code, 0);
        return output;
      });
      child.stdin.end(JSON.stringify(input));
      return { child, ended };
    },
    async channel(adapterVersion) {
      const channel = new NativeRequestChannel({ env: launch.env, adapterVersion });
      channels.push(channel);
      await channel.ready;
      return channel;
    },
  };
}

test("a waiting Claude question survives repeated broker restarts and delivers exactly once", async (t) => {
  const f = await fixture(t);
  const { ended } = f.hook();
  const old = (await waitFor(() => f.broker.list("session"))).requests[0];
  for (let i = 0; i < 2; i++) {
    await f.restart();
    const current = (await waitFor(() => f.broker.list("session"))).requests;
    assert.equal(current.length, 1);
    assert.equal(current[0].id, old.id);
    assert.equal(current[0].status, "pending");
  }
  await f.broker.answer("session", old.id, {
    expectedRevision: 1,
    answers: { q0: ["Custom ü\nsecond line"] },
  });
  const output = JSON.parse(await ended);
  assert.equal(
    output.hookSpecificOutput.updatedInput.answers["Which destination?"],
    "Custom ü\nsecond line",
  );
  await assert.rejects(
    f.broker.answer("session", old.id, {
      expectedRevision: 1,
      answers: { q0: ["Remote"] },
    }),
    { status: 409 },
  );
  assert.equal(f.events.filter((event) => event.action === "request.created").length, 1);
  assert.equal(f.events.filter((event) => event.action === "request.answered").length, 1);
});

test("cached Claude hook commands use the refreshed server runtime after an update", async (t) => {
  const f = await fixture(t);
  const dispatcher = path.join(f.broker.directory, "claude-hook.sh");
  assert.ok(
    !f.command.includes(process.execPath),
    "cached hooks must not pin a release's Node executable",
  );
  const hooks = JSON.parse(await fs.readFile(f.hookFile, "utf8"));
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].timeout, 86400);
  await fs.writeFile(dispatcher, "#!/bin/sh\nexit 99\n");
  await f.restart();
  const { ended } = f.hook();
  const request = (await waitFor(() => f.broker.list("session"))).requests[0];
  await f.broker.answer("session", request.id, {
    expectedRevision: 1,
    answers: { q0: ["Local"] },
  });
  assert.equal(
    JSON.parse(await ended).hookSpecificOutput.updatedInput.answers["Which destination?"],
    "Local",
  );
  assert.equal((await fs.stat(dispatcher)).mode & 0o777, 0o700);
});

test("terminal handoff releases both Claude question hooks without selecting an answer", async (t) => {
  const f = await fixture(t);
  for (const hook_event_name of ["PreToolUse", "PermissionRequest"]) {
    const { ended } = f.hook({ ...question, hook_event_name });
    const request = (await waitFor(() => f.broker.list("session"))).requests[0];
    await f.broker.handoff("session", request.id, { expectedRevision: request.revision });
    assert.equal(await ended, "");
    assert.deepEqual((await f.broker.list("session")).requests, []);
  }
  assert.equal(f.events.filter((event) => event.action === "request.answered").length, 0);
});

test("legacy plugins migrate once and stay visibly outdated until a current hook connects", async (t) => {
  const f = await fixture(t);
  const file = f.launch.env.AGENTPIER_REQUEST_FILE;
  const original = JSON.parse(await fs.readFile(file, "utf8"));
  delete original.claudeHookVersion;
  await fs.writeFile(file, JSON.stringify(original));
  await fs.writeFile(f.hookFile, JSON.stringify({ hooks: {} }));
  await f.restart();
  assert.equal((await f.broker.list("session")).integration.reloadRequired, true);
  assert.equal(
    JSON.parse(await fs.readFile(f.hookFile, "utf8")).hooks.PreToolUse[0].hooks[0]
      .command,
    f.command,
  );
  await f.restart();
  assert.equal((await f.broker.list("session")).integration.reloadRequired, true);
  const legacy = await f.channel();
  legacy.close();
  assert.equal((await f.broker.list("session")).integration.reloadRequired, true);
  const { ended } = f.hook();
  const state = await waitFor(() => f.broker.list("session"));
  assert.equal(state.integration, undefined);
  await f.broker.answer("session", state.requests[0].id, {
    expectedRevision: 1,
    answers: { q0: ["Remote"] },
  });
  await ended;
  const current = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(current.token, original.token);
  assert.equal(current.accountId, original.accountId);
  assert.equal(current.claudeHookReloadRequired, undefined);
  await f.restart();
  assert.equal((await f.broker.list("session")).integration, undefined);
});

test("legacy AskUserQuestion approvals cannot masquerade as answered questions", async (t) => {
  const f = await fixture(t);
  const channel = await f.channel();
  const replies = [];
  channel.publish(
    "legacy-question",
    {
      kind: "permission",
      subject: { tool: "AskUserQuestion" },
      options: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    },
    async (answer) => replies.push(answer),
  );
  const request = (await waitFor(() => f.broker.list("session"))).requests[0];
  assert.equal(request.presentation, "claudeLegacyQuestion");
  await assert.rejects(
    f.broker.answer("session", request.id, { expectedRevision: 1, choice: "allow" }),
    { status: 400 },
  );
  assert.deepEqual(replies, []);
  await f.broker.handoff("session", request.id, { expectedRevision: 1 });
  assert.deepEqual(replies, [{ handoff: true }]);
});

test("a second broker cannot overwrite the live Claude dispatcher", async (t) => {
  const f = await fixture(t);
  const dispatcher = path.join(f.broker.directory, "claude-hook.sh");
  await fs.writeFile(dispatcher, "owned by the running server");
  const second = new RequestBroker({ dataDir: f.root, sessions: {} });
  await assert.rejects(second.ready, /already running/);
  assert.equal(await fs.readFile(dispatcher, "utf8"), "owned by the running server");
});

test("unsupported Claude questions release the native hook instead of looping on reconnect", async (t) => {
  const f = await fixture(t);
  const { ended } = f.hook({
    ...question,
    tool_input: {
      questions: [
        {
          question: "Duplicate choices",
          options: [{ label: "Same" }, { label: "Same" }],
        },
      ],
    },
  });
  assert.equal(await ended, "");
  assert.deepEqual((await f.broker.list("session")).requests, []);
});

test("incomplete old launch records do not prevent the request broker from starting", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.broker.directory, "orphan.launch.json"),
    JSON.stringify({ id: "orphan", tool: "claude" }),
  );
  await fs.writeFile(path.join(f.broker.directory, "incomplete.launch.json"), "{");
  await f.restart();
  assert.deepEqual(await f.broker.list("session"), { requests: [] });
});
