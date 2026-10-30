import test from "node:test";
import assert from "node:assert/strict";
import {
  shellSegments,
  programKey,
} from "../../server/features/requests/shell-command.js";
import {
  DEFAULT_ALLOWED,
  defaultCommand,
} from "../../server/features/requests/cli-approval-defaults.js";

const allowed = (command) => {
  const segments = shellSegments(command);
  return Boolean(segments?.every(defaultCommand));
};

test("read-only commands on the default list need no card", () => {
  for (const command of [
    "git status",
    "git -C /work/repo log --oneline -20",
    "git diff HEAD~1 -- src",
    "git show HEAD:package.json",
    "git branch -a",
    "git branch --show-current",
    "git rev-parse --abbrev-ref HEAD",
    "git fetch origin",
    "grep -rn 'needle' src",
    "rg --files | head -50",
    "sed -n '1,80p' server/app.js",
    "sed -n -e '/start/,/end/p' notes.md",
    "sed 's/a/b/g' input.txt",
    "cat package.json",
    "head -5 a.js && tail -n 20 b.js",
    "ls -la; wc -l src/*.js",
    "npm test",
    "npm test -- --grep inbox 2>&1 | tail -30",
    "npm run test:unit",
    "npm run lint",
    "npm run check >/dev/null 2>&1",
  ])
    assert.equal(allowed(command), true, command);
});

test("anything that writes, runs other programs or reads secrets keeps asking", () => {
  for (const command of [
    "rm -rf build",
    "git push origin main",
    "git reset --hard",
    "git checkout main",
    "git branch -D old",
    "git branch feature",
    "git -c core.pager=evil log",
    "git diff --output=/tmp/x",
    "git fetch --upload-pack=evil origin",
    "sed -i 's/a/b/' file",
    "sed -n 'w out' file",
    "sed 's/a/b/e' file",
    "sed -f script.sed file",
    "rg --pre ./run.sh foo",
    "cat .env",
    "cat ~/.ssh/id_ed25519",
    "grep -r password config",
    "cat ~/.aws/credentials",
    "ssh host ls",
    "scp a host:b",
    "npm install left-pad",
    "npm run build",
    "npm publish",
    "ls > listing.txt",
    "cat a >> b",
    "cat < input",
    "ls | tee out",
    "ls | xargs rm",
    "echo $(whoami)",
    "ls `pwd`",
    'cat "$HOME/file"',
    "ls $HOME",
    "ls &",
    "(ls)",
    "{ ls; }",
    "PAGER=evil git log",
    "git status && rm -rf /",
    "/usr/bin/cat file",
    "./ls",
    "ls # comment",
  ])
    assert.equal(allowed(command), false, command);
});

test("remembered approvals name a program with its subcommand", () => {
  assert.deepEqual(shellSegments("git -C /x push origin && rm -rf a").map(programKey), [
    "git push",
    "rm",
  ]);
  assert.equal(programKey(["npm", "--silent", "install", "x"]), "npm install");
  assert.equal(programKey(["docker"]), "docker");
});

test("the default list is one frozen constant", () => {
  assert.equal(Object.isFrozen(DEFAULT_ALLOWED), true);
  assert.deepEqual(DEFAULT_ALLOWED.claudeTools, ["EnterWorktree", "ExitWorktree"]);
  assert.equal(DEFAULT_ALLOWED.gitSubcommands.includes("push"), false);
});
