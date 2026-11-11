import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixture, hook, pending } from "../helpers/claude-hook-fixture.js";
import { RequestApprovals } from "../../server/features/requests/request-approvals.js";

// A remembered program covers its arguments, except the few forms that lose data,
// write outside the project or choose what git runs (risky-forms.js).

const stored = path.join(
  import.meta.dirname,
  "../fixtures/requests/remembered-approvals-2.18.0.json",
);
const session = { id: "s-1", cwd: "/work/repo" };
const request = (command, source = "claude", tool = "Bash") => ({
  kind: "permission",
  source,
  subject: { tool, command },
  options: [
    { id: "allow", label: "Allow", scope: "once" },
    { id: "deny", label: "Deny" },
  ],
});
async function approvalsFromStored(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-approvals-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.copyFile(stored, path.join(directory, "remembered-approvals.json"));
  return {
    directory,
    approvals: new RequestApprovals({
      directory,
      scope: async () => ({ id: "project-1" }),
    }),
  };
}

test("approvals stored by 2.18.0 are read whole and keep answering", async (t) => {
  const { approvals, directory } = await approvalsFromStored(t);
  const before = JSON.parse(await fs.readFile(stored, "utf8"));
  assert.equal(approvals.rules.length, 11);
  assert.deepEqual(approvals.rules, before.rules);
  assert.equal(approvals.list("project-1").length, 11);
  for (const [command, decision] of [
    ["git branch feature", "allow-project"],
    ["git branch -m old new", "allow-project"],
    ["git log --show-signature", "allow-project"],
    ["git log --onel -3", "allow-project"],
    ["git -C /other/repo log", "allow-project"],
    ["git push", "allow-project"],
    ["git push -u origin feature", "allow-project"],
    ["rm a.txt", "allow-project"],
    ["rm -f a.txt b.txt", "allow-project"],
    ["npm run build", "allow-project"],
    ["npm run deploy -- --force", "allow-project"],
    ["npm run anything:at-all", "allow-project"],
    ["git config user.name", "allow-project"],
    ["git config --get remote.origin.url", "allow-project"],
    ["cat .env", "allow-project"],
    ["git reset HEAD~1", "allow-session"],
    ["git reset --soft HEAD~1", "allow-session"],
    ["git checkout main", "allow-session"],
    ["git checkout -- src/a.js", "allow-session"],
    ["rm a.txt && git push origin main", "allow-project"],
    ["git status && rm a.txt", "allow-project"],
  ])
    assert.deepEqual(
      await approvals.prepare(request(command), session),
      { choice: "allow", decision },
      command,
    );
  const webFetch = { ...request(undefined, "claude", "WebFetch") };
  delete webFetch.subject.command;
  assert.deepEqual(await approvals.prepare(webFetch, session), {
    choice: "allow",
    decision: "allow-project",
  });
  assert.deepEqual(
    await approvals.prepare(
      request("rm a.txt", "codex", "item/commandExecution/requestApproval"),
      session,
    ),
    { choice: "allow", decision: "allow-project" },
  );
  // Reading the file changes nothing in it.
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(directory, "remembered-approvals.json"), "utf8"),
    ),
    before,
  );
});

test("a remembered program does not cover a form that loses data or writes elsewhere", async (t) => {
  const { approvals } = await approvalsFromStored(t);
  for (const [command, program] of [
    ["git branch -D main", "git branch"],
    ["git branch -d old", "git branch"],
    ["git branch -M old new", "git branch"],
    ["git log --output=/tmp/x", "git log"],
    ["git log --outp /tmp/x -1", "git log"],
    ["git push --force", "git push"],
    ["git push -f origin main", "git push"],
    ["git push --force-with-lease origin main", "git push"],
    ["git push --delete origin old", "git push"],
    ["git push --mirror", "git push"],
    ["git push origin +main", "git push"],
    ["git push --receive-pack=evil origin main", "git push"],
    ["git reset --hard", "git reset"],
    ["git reset --hard HEAD~3", "git reset"],
    ["git checkout -- .", "git checkout"],
    ["git checkout -f main", "git checkout"],
    ["git config user.name x", "git config"],
    ["git config --global core.pager evil", "git config"],
    ["git config --unset user.name", "git config"],
    ["rm -rf build", "rm"],
    ["rm -r build", "rm"],
    ["rm /etc/hosts", "rm"],
    ["rm ~/notes.md", "rm"],
  ]) {
    const entry = request(command);
    assert.equal(await approvals.prepare(entry, session), null, command);
    assert.deepEqual(
      entry.options
        .filter((option) => option.remember)
        .map((option) => option.remember.programs),
      [[command], [command]],
      command,
    );
    assert.deepEqual(entry.exactOnly, { programs: [program] }, command);
  }
});

test("rm is judged where the chain has taken the shell", async (t) => {
  const { approvals } = await approvalsFromStored(t);
  const entry = request("cd .. && rm a.txt");
  assert.equal(await approvals.prepare(entry, session), null);
  assert.deepEqual(entry.options.find((option) => option.remember).remember.programs, [
    "cd",
    "rm a.txt",
  ]);
  assert.deepEqual(entry.exactOnly, { programs: ["rm"] });
  assert.deepEqual(await approvals.prepare(request("cd sub && rm a.txt"), session), {
    choice: "allow",
    decision: "allow-project",
  });
});

test("an ordinary card carries no such note", async (t) => {
  const { approvals } = await approvalsFromStored(t);
  for (const command of ["git commit -m x", "docker ps", "cat secrets/other.key"]) {
    const entry = request(command);
    assert.equal(await approvals.prepare(entry, session), null, command);
    assert.equal("exactOnly" in entry, false, command);
  }
  const mixed = request("git stash drop && docker ps && git stash clear");
  assert.equal(await approvals.prepare(mixed, session), null);
  assert.deepEqual(mixed.exactOnly, { programs: ["git stash"] });
  assert.deepEqual(mixed.options.find((option) => option.remember).remember.programs, [
    "git stash drop",
    "docker ps",
    "git stash clear",
  ]);
});

test("such a form is remembered exactly, and only that command is answered", async (t) => {
  const { approvals, directory } = await approvalsFromStored(t);
  const entry = request("git branch -D old");
  assert.equal(await approvals.prepare(entry, session), null);
  await approvals.remember(entry, "project", session);
  const rule = approvals.rules.at(-1);
  assert.deepEqual(
    { scope: rule.scope, program: rule.program, command: rule.command },
    { scope: "project", program: undefined, command: "git branch -D old" },
  );
  assert.deepEqual(await approvals.prepare(request("git branch -D old"), session), {
    choice: "allow",
    decision: "allow-project",
  });
  assert.equal(await approvals.prepare(request("git branch -D main"), session), null);
  // The stored file keeps its shape: the rules of 2.18.0 and the new one.
  const file = JSON.parse(
    await fs.readFile(path.join(directory, "remembered-approvals.json"), "utf8"),
  );
  assert.equal(file.rules.length, 12);
  assert.deepEqual(Object.keys(file.rules.at(-1)).sort(), [
    "cli",
    "command",
    "createdAt",
    "id",
    "scope",
    "target",
    "tool",
  ]);
  const reread = new RequestApprovals({
    directory,
    scope: async () => ({ id: "project-1" }),
  });
  assert.equal(reread.rules.length, 12);
});

test("the card of such a form says why and offers the exact command", async (t) => {
  const f = await fixture(t);
  const bash = (command) => ({
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command },
  });
  const first = hook(f, bash("git branch feature"), { timeout: 20_000 });
  const card = await pending(f);
  assert.equal(card.exactOnly, undefined);
  await f.broker.answer("session", card.id, {
    expectedRevision: 1,
    choice: "remember-session",
  });
  await first.done;
  const covered = hook(f, bash("git branch other"), { timeout: 20_000 });
  await covered.done;
  const second = hook(f, bash("git branch -D feature"), { timeout: 20_000 });
  const asked = await pending(f);
  assert.deepEqual(asked.exactOnly, { programs: ["git branch"] });
  assert.deepEqual(
    asked.options
      .filter((option) => option.remember)
      .map((option) => option.remember.programs),
    [["git branch -D feature"], ["git branch -D feature"]],
  );
  await f.broker.answer("session", asked.id, { expectedRevision: 1, choice: "deny" });
  await second.done;
});
