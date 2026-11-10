import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { RequestApprovals } from "../../server/features/requests/request-approvals.js";
import { handOver } from "../../server/features/requests/claude-hook-handover.js";

// What a sandboxed session may write in the request folder must not be run or
// trusted by the server or by another session: the Claude hook dispatcher and the
// remembered approvals live in folders of their own.
const question = {
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }],
  },
};
const rule = {
  id: "rule-1",
  scope: "project",
  target: "project-1",
  cli: "claude",
  tool: "WebFetch",
};
async function waitFor(read) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const state = await read();
    if (state.requests.length) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("request did not appear");
}
async function fixture(t, { before } = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-request-trust-")),
  );
  await before?.(root);
  const session = {
    id: "session",
    tool: "claude",
    accountId: "account",
    status: "running",
    nativeRequests: { enabled: true },
  };
  const config = { dataDir: root, sessions: { get: async () => session } };
  let broker = new RequestBroker(config);
  const children = [];
  t.after(async () => {
    for (const child of children) child.kill();
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const launch = await broker.prepare({
    id: session.id,
    account: { id: session.accountId, tool: "claude" },
    cwd: root,
    launch: { command: "claude", args: [], env: {}, cliVersion: "2.1.300" },
  });
  const hookFile = path.join(root, "requests/session.claude/hooks/hooks.json");
  const command = async () =>
    JSON.parse(await fs.readFile(hookFile, "utf8")).hooks.PreToolUse[0].hooks[0].command;
  return {
    root,
    launch,
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
    /** Runs a hook command the way Claude Code does and answers its question. */
    async ask(line) {
      const child = spawn("/bin/sh", ["-c", line], { env: launch.env, cwd: root });
      children.push(child);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stdin.end(JSON.stringify(question));
      const request = (await waitFor(() => broker.list("session"))).requests[0];
      await broker.answer("session", request.id, {
        expectedRevision: 1,
        answers: { q0: ["A"] },
      });
      await once(child, "close");
      return JSON.parse(output).hookSpecificOutput.updatedInput.answers["Which one?"];
    },
  };
}
const line = (file) => `'/bin/sh' '${file}'`;
const legacyDispatcher = (root) => path.join(root, "requests/claude-hook.sh");
const dispatcher = (root) => path.join(root, "request-runtime/claude-hook.sh");

test("a new Claude launch runs its hooks from the runtime folder", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.command(), line(dispatcher(f.root)));
  assert.equal(f.launch.env.AGENTPIER_CLAUDE_HOOK_DISPATCHER, dispatcher(f.root));
  assert.equal((await fs.stat(dispatcher(f.root))).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(path.join(f.root, "request-runtime")), [
    "claude-hook.sh",
  ]);
  // Something put where the dispatcher used to lie does not reach this launch.
  await fs.writeFile(legacyDispatcher(f.root), "#!/bin/sh\nexit 99\n");
  assert.equal(await f.ask(await f.command()), "A");
});

test("the hook command of a session started before still works after a restart", async (t) => {
  const f = await fixture(t);
  const before = line(legacyDispatcher(f.root));
  assert.equal(
    await fs.readFile(legacyDispatcher(f.root), "utf8"),
    await fs.readFile(dispatcher(f.root), "utf8"),
  );
  assert.equal((await fs.stat(legacyDispatcher(f.root))).mode & 0o777, 0o700);
  await fs.rm(legacyDispatcher(f.root));
  await f.restart();
  assert.equal(await f.ask(before), "A");
});

test("a launch from before the runtime folder keeps its dispatcher when its hooks are rewritten", async (t) => {
  const f = await fixture(t);
  const file = f.launch.env.AGENTPIER_REQUEST_FILE;
  const old = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(old.claudeHookDispatcher, dispatcher(f.root));
  delete old.claudeHookDispatcher;
  delete old.claudeHookVersion;
  await fs.writeFile(file, JSON.stringify(old));
  await fs.writeFile(f.hookFile, JSON.stringify({ hooks: {} }));
  await f.restart();
  assert.equal(await f.command(), line(legacyDispatcher(f.root)));
  // A dispatcher the launch file merely claims is never written into the hooks.
  await fs.writeFile(
    file,
    JSON.stringify({ ...old, claudeHookDispatcher: "/planted/hook.sh" }),
  );
  await fs.writeFile(f.hookFile, JSON.stringify({ hooks: {} }));
  await f.restart();
  assert.equal(await f.command(), line(legacyDispatcher(f.root)));
});

test("a Claude launch may write only its own plugin folders in the request folder", async (t) => {
  const f = await fixture(t);
  const requests = path.join(f.root, "requests");
  const files = f.launch.sandboxGrants.filter(
    (grant) => !grant.access.startsWith("socket") && grant.path.startsWith(f.root),
  );
  assert.deepEqual(
    files.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { access: "read", path: path.join(f.root, "request-runtime") },
      { access: "read", path: requests },
      { access: "allow", path: path.join(requests, "session.claude") },
      { access: "allow", path: path.join(requests, "session.claude-bridge") },
    ],
  );
});

test("an OpenCode launch may write only its own TUI configuration", async (t) => {
  const f = await fixture(t);
  const launch = await f.broker.prepare({
    id: "open",
    account: { id: "account", tool: "opencode" },
    cwd: f.root,
    launch: { command: "opencode", args: [], env: {} },
  });
  const requests = path.join(f.root, "requests");
  assert.deepEqual(
    launch.sandboxGrants.filter((grant) => grant.path.startsWith(f.root)),
    [
      { access: "read", path: requests },
      { access: "allow", path: path.join(requests, "open.tui.json") },
    ],
  );
});

test("remembered approvals move to the server's own folder once", async (t) => {
  const f = await fixture(t, {
    async before(root) {
      await fs.mkdir(path.join(root, "requests"), { recursive: true });
      await fs.writeFile(
        path.join(root, "requests/remembered-approvals.json"),
        JSON.stringify({ rules: [rule] }),
      );
    },
  });
  const legacy = path.join(f.root, "requests/remembered-approvals.json");
  const current = path.join(f.root, "request-state/remembered-approvals.json");
  assert.deepEqual(f.broker.approvals.list("project-1"), [rule]);
  assert.deepEqual(JSON.parse(await fs.readFile(current, "utf8")).rules, [rule]);
  assert.equal((await fs.stat(current)).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(legacy), { code: "ENOENT" });
  // A file put at the old place later is not read again.
  await fs.writeFile(
    legacy,
    JSON.stringify({ rules: [{ ...rule, id: "planted", tool: "Bash" }] }),
  );
  await f.restart();
  assert.deepEqual(f.broker.approvals.list("project-1"), [rule]);
});

test("without earlier approvals a file put at the old place is never taken over", async (t) => {
  const f = await fixture(t);
  const current = path.join(f.root, "request-state/remembered-approvals.json");
  assert.deepEqual(JSON.parse(await fs.readFile(current, "utf8")).rules, []);
  await fs.writeFile(
    path.join(f.root, "requests/remembered-approvals.json"),
    JSON.stringify({ rules: [rule] }),
  );
  await f.restart();
  assert.deepEqual(f.broker.approvals.list("project-1"), []);
});

test("approvals without an old folder read and write one file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-approvals-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const approvals = new RequestApprovals({ directory });
  assert.deepEqual(approvals.rules, []);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("a waiting hook hands over through the dispatcher its launch names", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-handover-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "requests"));
  await fs.mkdir(path.join(root, "runtime"));
  await fs.writeFile(path.join(root, "requests/claude-hook.sh"), "echo beside\n");
  await fs.writeFile(path.join(root, "runtime/claude-hook.sh"), "echo named\n");
  const run = async (extra) => {
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => {
      text += chunk;
    });
    await handOver({
      env: {
        PATH: process.env.PATH,
        AGENTPIER_REQUEST_FILE: path.join(root, "requests/session.launch.json"),
        ...extra,
      },
      text: "{}",
      output,
      state: { key: "k", epoch: "e", deadline: 1, hops: 1 },
    });
    return text.trim();
  };
  assert.equal(
    await run({
      AGENTPIER_CLAUDE_HOOK_DISPATCHER: path.join(root, "runtime/claude-hook.sh"),
    }),
    "named",
  );
  // A session started before the dispatcher was named.
  assert.equal(await run({}), "beside");
});
