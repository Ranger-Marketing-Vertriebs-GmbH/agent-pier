import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliMcpFixture } from "../helpers/cli-mcp.js";
import { PackageSkills } from "../../server/features/mcp-packages/package-skills.js";
import { bundledSkills } from "../../server/features/mcp-packages/package-skill-scan.js";
import { reaSkill, syncReaSkills } from "../../server/features/tools/rea-skills.js";

const document = `---\nname: ${reaSkill}\ndescription: Reverse engineer anything.\n---\n# Steps\n`;

/**
 * Real account, extension and server stores (temporary HOME) with the real
 * PackageSkills; only the package's install folder is a plain folder here.
 */
function fixture(t) {
  const f = cliMcpFixture(t);
  const pkg = path.join(f.root, "pkg");
  fs.mkdirSync(path.join(pkg, "skills", reaSkill), { recursive: true });
  fs.writeFileSync(path.join(pkg, "skills", reaSkill, "SKILL.md"), document);
  const server = f.servers.create({
    name: "rea",
    transport: "stdio",
    command: "/fake/bin/rea",
    args: [],
  });
  const record = { registry: "npm", name: "rea-agents", version: "6.8.0" };
  const service = {
    dataDir: f.dataDir,
    servers: f.servers,
    records: { get: () => record },
    requireIdle() {},
  };
  const packageSkills = new PackageSkills(service, f.extensions);
  packageSkills.bundled = () => bundledSkills(pkg);
  const sync = () =>
    syncReaSkills({
      serverId: server.id,
      servers: f.servers,
      packageSkills,
      extensions: f.extensions,
    });
  const copy = (cli) => path.join(f.home, `.${cli}`, "skills", reaSkill);
  return { ...f, server, packageSkills, sync, copy };
}

test("copies the skill into profiles of bound CLIs only", async (t) => {
  const f = fixture(t);
  f.servers.setClis(f.server.id, ["claude"]);
  await f.sync();
  assert.equal(
    fs.readFileSync(path.join(f.copy("claude"), "SKILL.md"), "utf8"),
    document,
  );
  assert.equal(fs.existsSync(f.copy("codex")), false);
  const owned = f.packageSkills.owned(f.server.id);
  assert.deepEqual(
    owned.map((item) => [item.accountId, item.name]),
    [["local-claude", reaSkill]],
  );
  // A second sync leaves the owned copy as it is.
  await f.sync();
  assert.equal(f.packageSkills.owned(f.server.id).length, 1);
});

test("an owner's own skill folder of the same name is left alone", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.copy("claude"), { recursive: true });
  fs.writeFileSync(path.join(f.copy("claude"), "SKILL.md"), "mine");
  f.servers.setClis(f.server.id, ["claude", "codex"]);
  await f.sync();
  assert.equal(fs.readFileSync(path.join(f.copy("claude"), "SKILL.md"), "utf8"), "mine");
  assert.deepEqual(
    f.packageSkills.owned(f.server.id).map((item) => item.accountId),
    ["local-codex"],
  );
});

test("unbinding a CLI removes the owned copy there; a changed copy is only forgotten", async (t) => {
  const f = fixture(t);
  f.servers.setClis(f.server.id, ["claude", "codex"]);
  await f.sync();
  assert.equal(f.packageSkills.owned(f.server.id).length, 2);
  fs.writeFileSync(path.join(f.copy("codex"), "notes.md"), "mine");
  f.servers.setClis(f.server.id, []);
  await f.sync();
  assert.equal(fs.existsSync(f.copy("claude")), false);
  // The owner's change keeps the copy; it is theirs now.
  assert.equal(fs.readFileSync(path.join(f.copy("codex"), "notes.md"), "utf8"), "mine");
  assert.deepEqual(f.packageSkills.owned(f.server.id), []);
});
