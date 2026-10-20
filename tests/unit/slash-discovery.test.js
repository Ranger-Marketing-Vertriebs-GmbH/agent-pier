import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SlashCommandService,
  discoverSlashCommands,
} from "../../server/features/chat/slash-command-service.js";

async function tree(t, files) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-slash-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return root;
}

const doc = (fields, body = "SECRET BODY TEXT") =>
  `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n---\n${body}\n`;

const byName = (commands) => Object.fromEntries(commands.map((c) => [c.name, c]));

test("Claude Code: profile, project and enabled plugin commands and skills", async (t) => {
  const home = await tree(t, {
    "profile/commands/deploy.md": doc({
      description: "Deploy the app",
      "argument-hint": "[env] [tag]",
    }),
    "profile/commands/team/review-pr.md": doc({ description: "Review a PR" }),
    "profile/commands/plain.md": "No frontmatter, only a SECRET BODY TEXT",
    "profile/skills/writer/SKILL.md": doc({
      name: "writer",
      description: "|\n  Writes things\n  well",
    }),
    "profile/skills/hidden/SKILL.md": doc({ name: "hidden", "user-invocable": false }),
    "profile/settings.json": {
      enabledPlugins: { "tools@market": true, "off@market": true, "proj@market": true },
    },
    "profile/plugins/installed_plugins.json": {
      version: 2,
      plugins: {
        "tools@market": [{ scope: "user", installPath: "PLUGINS/tools" }],
        "off@market": [{ scope: "user", installPath: "PLUGINS/off" }],
        "proj@market": [
          { scope: "project", projectPath: "/elsewhere", installPath: "PLUGINS/proj" },
        ],
        "never@market": [{ scope: "user", installPath: "PLUGINS/never" }],
      },
    },
    "plugins/tools/.claude-plugin/plugin.json": {
      name: "toolbox",
      skills: ["./extra/nested/one", "../../escape"],
    },
    "plugins/tools/commands/lint.md": doc({
      description: "Lint",
      "argument-hint": "<path>",
    }),
    "plugins/tools/skills/fmt/SKILL.md": doc({ description: "Format code" }),
    "plugins/tools/extra/nested/one/SKILL.md": doc({ name: "one", description: "One" }),
    "plugins/off/commands/off.md": doc({ description: "Off" }),
    "plugins/proj/commands/proj.md": doc({ description: "Project only" }),
    "plugins/never/commands/never.md": doc({ description: "Not enabled" }),
    "escape/SKILL.md": doc({ name: "escape" }),
    "project/.claude/commands/test.md": doc({ description: "Run tests" }),
    "project/.claude/skills/ship/SKILL.md": doc({ description: "Ship it" }),
    "project/.claude/settings.local.json": { enabledPlugins: { "off@market": false } },
  });
  // installPath values are absolute in Claude Code's file.
  const installed = path.join(home, "profile/plugins/installed_plugins.json");
  await fs.writeFile(
    installed,
    (await fs.readFile(installed, "utf8")).replaceAll("PLUGINS", `${home}/plugins`),
  );
  await fs.symlink("/etc/hosts", path.join(home, "project/.claude/commands/link.md"));
  const { commands, watched } = await discoverSlashCommands({
    tool: "claude",
    env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, "profile") },
    cwd: path.join(home, "project"),
  });
  const found = byName(commands);
  assert.deepEqual(Object.keys(found).sort(), [
    "deploy",
    "plain",
    "review-pr",
    "ship",
    "test",
    "toolbox:fmt",
    "toolbox:lint",
    "toolbox:one",
    "writer",
  ]);
  assert.deepEqual(found.deploy, {
    name: "deploy",
    kind: "command",
    scope: "user",
    description: "Deploy the app",
    argumentHint: "[env] [tag]",
  });
  assert.equal(found.writer.description, "Writes things well");
  assert.equal(found.writer.kind, "skill");
  assert.equal(found.plain.description, undefined);
  assert.deepEqual(found["toolbox:lint"], {
    name: "toolbox:lint",
    kind: "command",
    scope: "plugin",
    plugin: "toolbox",
    description: "Lint",
    argumentHint: "<path>",
  });
  assert.equal(found.test.scope, "project");
  assert.ok(watched.includes(installed));
  // Only frontmatter fields leave the server, never a document's body.
  assert.equal(JSON.stringify(commands).includes("SECRET"), false);
});

test("Claude Code without a profile or project finds nothing and never fails", async (t) => {
  const home = await tree(t, {});
  const result = await discoverSlashCommands({
    tool: "claude",
    env: { HOME: home },
    cwd: path.join(home, "missing"),
  });
  assert.deepEqual(result.commands, []);
  assert.deepEqual(
    (await discoverSlashCommands({ tool: "shell", env: {} })).commands,
    [],
  );
});

test("Codex custom prompts are /prompts: commands", async (t) => {
  const home = await tree(t, {
    "codex/prompts/draftpr.md": doc({
      description: "Draft a PR",
      "argument-hint": "FILES=<paths> [PR_TITLE]",
    }),
    "codex/prompts/notes.txt": "ignored",
    "codex/skills/skill/SKILL.md": doc({ description: "Skills use $ mentions" }),
  });
  const { commands } = await discoverSlashCommands({
    tool: "codex",
    env: { HOME: home, CODEX_HOME: path.join(home, "codex") },
    cwd: home,
  });
  assert.deepEqual(commands, [
    {
      name: "prompts:draftpr",
      kind: "prompt",
      scope: "user",
      description: "Draft a PR",
      argumentHint: "FILES=<paths> [PR_TITLE]",
    },
  ]);
});

test("OpenCode commands from Markdown folders and JSON config", async (t) => {
  const home = await tree(t, {
    "config/opencode/command/test.md": doc({ description: "Run the tests" }),
    "config/opencode/commands/git/commit.md": doc({ description: "Commit" }),
    "config/opencode/opencode.jsonc":
      '{\n  // comment\n  "command": { "component": { "template": "SECRET", "description": "New component" } },\n}',
    "project/.opencode/command/local.md": doc({ description: "Local" }),
    "project/opencode.json": { command: { review: { description: "Review" } } },
  });
  const { commands } = await discoverSlashCommands({
    tool: "opencode",
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, "config") },
    cwd: path.join(home, "project"),
  });
  const found = byName(commands);
  assert.deepEqual(Object.keys(found).sort(), [
    "component",
    "git/commit",
    "local",
    "review",
    "test",
  ]);
  assert.equal(found.component.description, "New component");
  assert.equal(found.local.scope, "project");
  assert.equal(JSON.stringify(commands).includes("SECRET"), false);
});

test("a project folder that links elsewhere is not followed", async (t) => {
  const home = await tree(t, {
    "outside/commands/leak.md": doc({ description: "Outside" }),
    "project/README.md": "x",
  });
  await fs.symlink(path.join(home, "outside"), path.join(home, "project/.claude"));
  const { commands } = await discoverSlashCommands({
    tool: "claude",
    env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, "profile") },
    cwd: path.join(home, "project"),
  });
  assert.deepEqual(commands, []);
});

test("the service caches per account and project and rereads after a change", async (t) => {
  const home = await tree(t, {
    "profile/commands/one.md": doc({ description: "One" }),
  });
  let clock = 0;
  const session = {
    id: "s1",
    tool: "claude",
    accountId: "a1",
    cwd: path.join(home, "project"),
  };
  let reads = 0;
  const service = new SlashCommandService({
    sessions: { get: async () => session },
    accounts: {
      get: () => ({ id: "a1", tool: "claude" }),
      environment: () => {
        reads++;
        return { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, "profile") };
      },
    },
    now: () => clock,
  });
  const names = async () => (await service.list("s1")).commands.map((c) => c.name);
  assert.deepEqual(await names(), ["one"]);
  await fs.writeFile(path.join(home, "profile/commands/two.md"), doc({}));
  // Within the recheck interval the cached list answers.
  assert.deepEqual(await names(), ["one"]);
  clock += 5000;
  assert.deepEqual(await names(), ["one", "two"]);
  assert.equal(reads, 2);
  clock += 5000;
  await names();
  assert.equal(reads, 2, "an unchanged folder is not read again");
  session.tool = "shell";
  await assert.rejects(service.list("s1"), { status: 409 });
});
