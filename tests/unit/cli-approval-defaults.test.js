import test from "node:test";
import assert from "node:assert/strict";
import {
  shellSegments,
  programKey,
} from "../../server/features/requests/shell-command.js";
import {
  DEFAULT_ALLOWED,
  defaultSegments,
  defaultClaudeTool,
  printScript,
  substitution,
} from "../../server/features/requests/cli-approval-defaults.js";

// The session's project is /work/repo and its shell stands there.
const place = { cwd: "/work/repo", roots: ["/work/repo"] };
const allowed = (command) => {
  const segments = shellSegments(command);
  return Boolean(segments && defaultSegments(segments, place).every(Boolean));
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
    "cd sub && git status",
    "cd /work/repo; ls",
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
    "cd sub && rm x",
    "cd a b",
    "cd .ssh",
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

test("the AgentBus tools that only read are default-allowed for Claude with AgentBus", () => {
  const prefix = "mcp__plugin_agentpier-agentbus_agentpier_agentbus__";
  // The names a real Claude Code reports for the plugin AgentPier passes.
  assert.deepEqual(DEFAULT_ALLOWED.claudeAgentBusTools, [
    prefix + "peers_list",
    prefix + "inbox_read",
  ]);
  assert.equal(Object.isFrozen(DEFAULT_ALLOWED.claudeAgentBusTools), true);
  const withBus = { agentBus: true };
  for (const name of ["peers_list", "inbox_read"]) {
    assert.equal(defaultClaudeTool(prefix + name, withBus), true, name);
    // A session started without AgentBus has no such plugin of AgentPier's.
    assert.equal(defaultClaudeTool(prefix + name), false, name);
    assert.equal(defaultClaudeTool(prefix + name, { agentBus: "yes" }), false);
  }
  for (const name of [
    prefix + "peer_send",
    "mcp__other__inbox_read",
    "mcp__plugin_agentpier-agentbus_other__inbox_read",
    "mcp__plugin_other_agentpier_agentbus__inbox_read",
    "mcp__agentpier_agentbus__inbox_read",
    "agentpier_agentbus_inbox_read",
    "inbox_read",
    "peers_list",
    prefix + "inbox_read_all",
    prefix + "inbox_read ",
    "x" + prefix + "inbox_read",
    prefix,
    prefix.toUpperCase() + "inbox_read",
    "",
    undefined,
    ["EnterWorktree"],
  ])
    assert.equal(defaultClaudeTool(name, withBus), false, String(name));
  assert.equal(defaultClaudeTool("EnterWorktree"), true);
  assert.equal(defaultClaudeTool("ExitWorktree", withBus), true);
});

test("the default list names AgentBus as its Claude plugin registers it", async () => {
  const names = await import("../../server/features/agentbus/agentbus-names.js");
  const { toolsFor } = await import("../../vendor/agentbus/agentpier/runtime.js");
  const tools = toolsFor({ h: "/nowhere", launch: { tool: "claude" } }).map(
    (tool) => tool.name,
  );
  // Every tool on the list is one the AgentBus server offers.
  for (const tool of names.agentBusReadTools) assert.equal(tools.includes(tool), true);
  assert.equal(names.agentBusReadTools.includes("peer_send"), false);
  assert.equal(tools.includes("peer_send"), true);
  assert.equal(
    names.claudeAgentBusTool("inbox_read"),
    `mcp__plugin_${names.agentBusPluginName}_${names.agentBusServerName}__inbox_read`,
  );
});

test("sed scripts from the CLI are checked in linear time", () => {
  for (const [script, expected] of [
    ["0".repeat(50000), true],
    ["$," + "00$,".repeat(20000), false],
    ["$,+" + "00$,+".repeat(20000), false],
    ["1p;".repeat(20000), true],
    ["/" + "\\/".repeat(20000), false],
    ["s/" + "a".repeat(50000) + "/b/g", true],
    ["s/" + "\\".repeat(50001), false],
  ]) {
    const started = performance.now();
    const result = printScript(script) || substitution(script);
    assert.ok(performance.now() - started < 50, `slow for ${script.slice(0, 12)}…`);
    assert.equal(result, expected, script.slice(0, 12));
  }
  // The same scripts as before stay safe or unsafe.
  for (const script of [
    "1,80p",
    " /start/,/end/ p ",
    "5,$!d",
    "1p;3p",
    "$=",
    "10,+3p",
    "s/a\\/b/c/2",
  ])
    assert.equal(printScript(script) || substitution(script), true, script);
  for (const script of [
    "",
    "w out",
    "1w out",
    "s/a/b/e",
    "s/a/b/w x",
    "1,",
    "/open",
    "p",
    "e ls",
  ])
    assert.equal(printScript(script) || substitution(script), false, script);
});
