import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliMcpFixture } from "../helpers/cli-mcp.js";
import { craftSkill, syncCraftSkills } from "../../server/features/tools/craft-skills.js";
import { craftManifest } from "../../server/features/tools/craft-manifest.js";
import { PackageSkills } from "../../server/features/mcp-packages/package-skills.js";

const shipped = path.join(
  import.meta.dirname,
  "../../server/features/tools/craft-skill/craft-anything/SKILL.md",
);

function fixture(t) {
  const f = cliMcpFixture(t);
  const server = f.servers.create({
    name: "craft-anything",
    transport: "stdio",
    command: "/fake/bin/craft-anything-cli",
    args: [],
  });
  const sync = (options = {}) =>
    syncCraftSkills({
      serverId: server.id,
      servers: f.servers,
      extensions: f.extensions,
      ...options,
    });
  const copy = (cli) => path.join(f.home, `.${cli}`, "skills", craftSkill);
  const owned = () =>
    f.extensions.installed().filter((item) => item.package?.serverId === server.id);
  return { ...f, server, sync, copy, owned };
}

test("copies the skill into bound Claude profiles only", async (t) => {
  const f = fixture(t);
  f.servers.setClis(f.server.id, ["claude"]);
  await f.sync();
  assert.equal(
    fs.readFileSync(path.join(f.copy("claude"), "SKILL.md"), "utf8"),
    fs.readFileSync(shipped, "utf8"),
  );
  assert.equal(fs.existsSync(f.copy("codex")), false);
  assert.deepEqual(
    f.owned().map((item) => [item.accountId, item.name, item.package.registry]),
    [["local-claude", craftSkill, "agentpier"]],
  );
  assert.equal(f.owned()[0].package.version, craftManifest.version);
  await f.sync();
  assert.equal(f.owned().length, 1);
});

test("leaves the owner's own craft-anything folder", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.copy("claude"), { recursive: true });
  fs.writeFileSync(path.join(f.copy("claude"), "SKILL.md"), "mine");
  f.servers.setClis(f.server.id, ["claude"]);
  await f.sync();
  assert.equal(fs.readFileSync(path.join(f.copy("claude"), "SKILL.md"), "utf8"), "mine");
  assert.deepEqual(f.owned(), []);
});

test("unbinding removes the owned copy, and so does a null server", async (t) => {
  const f = fixture(t);
  f.servers.setClis(f.server.id, ["claude"]);
  await f.sync();
  f.servers.setClis(f.server.id, []);
  await f.sync();
  assert.equal(fs.existsSync(f.copy("claude")), false);
  f.servers.setClis(f.server.id, ["claude"]);
  await f.sync();
  assert.equal(fs.existsSync(f.copy("claude")), true);
  await syncCraftSkills({
    serverId: null,
    servers: f.servers,
    extensions: f.extensions,
  });
  assert.equal(fs.existsSync(f.copy("claude")), false);
  assert.deepEqual(f.owned(), []);
});

test("a newer pinned version replaces the owned copy", async (t) => {
  const f = fixture(t);
  f.servers.setClis(f.server.id, ["claude"]);
  await f.sync({ version: "0.4.0" });
  assert.equal(f.owned()[0].package.version, "0.4.0");
  const before = f.owned()[0].id;
  await f.sync({ version: "0.5.0" });
  assert.equal(f.owned().length, 1);
  assert.equal(f.owned()[0].id, before);
  assert.equal(f.owned()[0].package.version, "0.5.0");
});

test("package pruning keeps AgentPier's own copy", async (t) => {
  const f = fixture(t);
  f.servers.setClis(f.server.id, ["claude"]);
  await f.sync();
  new PackageSkills({}, f.extensions).prune(new Set());
  assert.equal(f.owned().length, 1);
  assert.equal(fs.existsSync(f.copy("claude")), true);
});

test("the shipped SKILL.md never instructs running setup", () => {
  const text = fs.readFileSync(shipped, "utf8");
  assert.match(text, /^---\nname: craft-anything\n/);
  assert.doesNotMatch(text, /run `craft-anything-cli setup/);
  assert.doesNotMatch(text, /setup --yes|--dry-run/);
  assert.match(text, /restricted_mode/);
  assert.match(text, /MIT OR Apache-2\.0/);
});
