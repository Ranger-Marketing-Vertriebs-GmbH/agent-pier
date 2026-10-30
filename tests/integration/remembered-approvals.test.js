import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixture, hook, pending, state } from "../helpers/claude-hook-fixture.js";
import { RequestApprovals } from "../../server/features/requests/request-approvals.js";
import { answerDecision } from "../../server/features/requests/request-delivery.js";
import { codexRequest } from "../../server/features/requests/codex-protocol.js";

const bash = (command) => ({
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command },
});
const tool = (name, input = {}) => ({
  hook_event_name: "PermissionRequest",
  tool_name: name,
  tool_input: input,
});
const answered = (f) => f.events.filter((event) => event.action === "request.answered");
const allowOutput = {
  hookEventName: "PermissionRequest",
  decision: { behavior: "allow" },
};

test("a default-allowed command and tool are answered without a card", async (t) => {
  const f = await fixture(t);
  for (const payload of [
    bash("git status && rg --files | head -20"),
    tool("EnterWorktree", { path: "/work/tree" }),
  ]) {
    const run = hook(f, payload, { timeout: 20_000 });
    await run.done;
    assert.deepEqual(JSON.parse(run.output()).hookSpecificOutput, allowOutput);
  }
  assert.equal((await state(f)).requests.length, 0);
  assert.deepEqual(
    answered(f).map((event) => [event.details.decision, event.details.auto]),
    [
      ["allow-default", true],
      ["allow-default", true],
    ],
  );
  assert.equal(
    f.events.some((event) => event.action === "request.created"),
    false,
    "no card, so no notification either",
  );
});

test("a command allowed for the session is answered for it from then on", async (t) => {
  const f = await fixture(t);
  const first = hook(f, bash("rm -rf build && git push origin main"), {
    timeout: 20_000,
  });
  const request = await pending(f);
  const remember = request.options.filter((option) => option.remember);
  assert.deepEqual(
    remember.map((option) => [option.id, option.scope, option.remember.programs]),
    [
      ["remember-session", "session", ["rm", "git push"]],
      ["remember-project", "project", ["rm", "git push"]],
    ],
  );
  // An agent answering for the owner cannot remember approvals.
  await assert.rejects(
    f.broker.answer(
      "session",
      request.id,
      { expectedRevision: 1, choice: "remember-session" },
      false,
      { kind: "agent", assistantId: "helper" },
    ),
    { status: 400 },
  );
  await f.broker.answer("session", request.id, {
    expectedRevision: 1,
    choice: "remember-session",
  });
  await first.done;
  assert.deepEqual(JSON.parse(first.output()).hookSpecificOutput, allowOutput);
  assert.equal(answered(f)[0].details.decision, "allow-session");
  // A later rm of the same session needs no card; git push alone neither.
  for (const command of ["rm -f a.txt", "git push"]) {
    const run = hook(f, bash(command), { timeout: 20_000 });
    await run.done;
    assert.deepEqual(JSON.parse(run.output()).hookSpecificOutput, allowOutput, command);
  }
  assert.deepEqual(
    answered(f).map((event) => event.details.decision),
    ["allow-session", "allow-session", "allow-session"],
  );
  // Another program, or a git subcommand never approved, still asks.
  const other = hook(f, bash("git reset --hard"), { timeout: 20_000 });
  const asked = await pending(f);
  await f.broker.answer("session", asked.id, { expectedRevision: 1, choice: "deny" });
  await other.done;
  // Redirections and substitutions are never answered automatically.
  const risky = hook(f, bash("rm -rf $(cat list)"), { timeout: 20_000 });
  const card = await pending(f);
  assert.equal(
    card.options.some((option) => option.remember),
    false,
    "an unreadable command is never remembered",
  );
  await f.broker.answer("session", card.id, { expectedRevision: 1, choice: "deny" });
  await risky.done;
});

test("a project approval survives a restart, is listed and can be removed", async (t) => {
  const f = await fixture(t);
  const first = hook(f, tool("WebFetch", { url: "https://example.com" }), {
    timeout: 20_000,
  });
  const request = await pending(f);
  await f.broker.answer("session", request.id, {
    expectedRevision: 1,
    choice: "remember-project",
  });
  await first.done;
  assert.equal(answered(f)[0].details.decision, "allow-project");
  await f.restart();
  const [rule] = f.broker.approvals.rules;
  assert.deepEqual(
    { scope: rule.scope, cli: rule.cli, tool: rule.tool, program: rule.program },
    { scope: "project", cli: "claude", tool: "WebFetch", program: undefined },
  );
  assert.deepEqual(
    f.broker.approvals.list(rule.target).map((r) => r.id),
    [rule.id],
  );
  const again = hook(f, tool("WebFetch", { url: "https://example.org" }), {
    timeout: 20_000,
  });
  await again.done;
  assert.deepEqual(JSON.parse(again.output()).hookSpecificOutput, allowOutput);
  f.broker.approvals.remove(rule.id);
  const stored = JSON.parse(
    await fs.readFile(path.join(f.root, "requests/remembered-approvals.json"), "utf8"),
  );
  assert.deepEqual(stored.rules, []);
  const asks = hook(f, tool("WebFetch", { url: "https://example.net" }), {
    timeout: 20_000,
  });
  const card = await pending(f);
  await f.broker.answer("session", card.id, { expectedRevision: 1, choice: "allow" });
  await asks.done;
  assert.throws(() => f.broker.approvals.remove(rule.id), { status: 404 });
});

test("a chain is allowed only when every part is on the list or remembered", async (t) => {
  const f = await fixture(t);
  const run = hook(f, bash("cd sub && git status"), { timeout: 20_000 });
  await run.done;
  assert.deepEqual(JSON.parse(run.output()).hookSpecificOutput, allowOutput);
  const asks = hook(f, bash("cd sub && rm x"), { timeout: 20_000 });
  const card = await pending(f);
  assert.deepEqual(
    card.options.find((option) => option.remember).remember.programs,
    ["rm"],
    "only the part outside the list needs an approval",
  );
  await f.broker.answer("session", card.id, { expectedRevision: 1, choice: "deny" });
  await asks.done;
});

test("a remembered program never covers a secret; a secret is remembered exactly", async (t) => {
  const f = await fixture(t);
  const ask = async (command) => {
    const run = hook(f, bash(command), { timeout: 20_000 });
    const card = await pending(f);
    return { run, card };
  };
  // Remember cat for the project from an ordinary card.
  const first = await ask("cat README.md | tee copy.md");
  await f.broker.answer("session", first.card.id, {
    expectedRevision: 1,
    choice: "remember-project",
  });
  await first.run.done;
  const plain = hook(f, bash("cat README.md docs/a.md"), { timeout: 20_000 });
  await plain.done;
  assert.deepEqual(JSON.parse(plain.output()).hookSpecificOutput, allowOutput);
  // A secret path still asks, and its card names exactly that command.
  const secret = await ask("cat .env");
  assert.deepEqual(
    secret.card.options.find((option) => option.remember).remember.programs,
    ["cat .env"],
  );
  await f.broker.answer("session", secret.card.id, {
    expectedRevision: 1,
    choice: "remember-project",
  });
  await secret.run.done;
  const again = hook(f, bash("cat .env"), { timeout: 20_000 });
  await again.done;
  assert.deepEqual(JSON.parse(again.output()).hookSpecificOutput, allowOutput);
  const other = await ask("cat secrets/other.key");
  await f.broker.answer("session", other.card.id, {
    expectedRevision: 1,
    choice: "deny",
  });
  await other.run.done;
  // A tool rule does not cover a secret path either.
  const readme = hook(f, tool("Read", { file_path: "/work/README.md" }), {
    timeout: 20_000,
  });
  const readCard = await pending(f);
  await f.broker.answer("session", readCard.id, {
    expectedRevision: 1,
    choice: "remember-session",
  });
  await readme.done;
  const key = hook(f, tool("Read", { file_path: "/work/.ssh/id_ed25519" }), {
    timeout: 20_000,
  });
  const keyCard = await pending(f);
  assert.deepEqual(keyCard.options.find((option) => option.remember).remember.programs, [
    "/work/.ssh/id_ed25519",
  ]);
  await f.broker.answer("session", keyCard.id, { expectedRevision: 1, choice: "deny" });
  await key.done;
});

test("Codex and OpenCode shell requests use the same defaults and rules", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-approvals-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const approvals = new RequestApprovals({
    directory,
    scope: async () => ({ id: "project-1" }),
  });
  const codex = codexRequest({
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "t",
      command: "git log -5",
      availableDecisions: ["accept", "acceptForSession", "decline"],
    },
  }).view;
  const session = { id: "s-1", cwd: "/work" };
  assert.deepEqual(await approvals.prepare({ ...codex, source: "codex" }, session), {
    choice: "accept",
    decision: "allow-default",
  });
  const opencode = {
    kind: "permission",
    source: "opencode",
    subject: { tool: "bash", command: "rm -rf dist" },
    options: [
      { id: "once", label: "Once", scope: "once" },
      { id: "reject", label: "Deny" },
    ],
  };
  assert.equal(await approvals.prepare(opencode, session), null);
  assert.deepEqual(
    opencode.options.map((option) => option.id),
    ["once", "remember-session", "remember-project", "reject"],
  );
  await approvals.remember(opencode, "project", session);
  assert.deepEqual(
    await approvals.prepare(
      { ...opencode, options: opencode.options.slice(0, 1) },
      session,
    ),
    {
      choice: "once",
      decision: "allow-project",
    },
  );
  // The same program under another CLI is not covered.
  const claude = {
    ...opencode,
    source: "claude",
    subject: { tool: "Bash", command: "rm -rf dist" },
    options: [{ id: "allow", label: "Allow" }],
  };
  assert.equal(await approvals.prepare(claude, session), null);
  // The CLI's own session approval is audited as one, not as a plain allow.
  assert.equal(
    answerDecision(
      { ...codex, kind: "permission" },
      { choice: "acceptForSession" },
      {},
      {},
    ),
    "allow-session",
  );
  assert.equal(
    answerDecision(
      { kind: "permission", options: [{ id: "always", scope: "persistent" }] },
      { choice: "always" },
      {},
      {},
    ),
    "allow-always",
  );
});
