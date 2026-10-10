import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
test("managed plugin assets are private, reproducible and repaired without adopting a symlink", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-plugin-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir),
    options = { paths, runtimeVersion: "2026.9.8" };
  const first = provisionTeamPlugin(options);
  assert.ok(fs.existsSync(path.join(first.directory, "index.js")));
  // Every module the shipped plugin imports is provisioned beside it.
  for (const name of fs.readdirSync(first.directory).filter((n) => n.endsWith(".js")))
    for (const [, target] of fs
      .readFileSync(path.join(first.directory, name), "utf8")
      .matchAll(/from "\.\/([^"]+)"/g))
      assert.ok(fs.existsSync(path.join(first.directory, target)), target);
  assert.ok(fs.existsSync(path.join(first.directory, "tool-guard.js")));
  assert.equal(fs.statSync(first.directory).mode & 0o777, 0o700);
  assert.deepEqual(provisionTeamPlugin(options), first);
  fs.unlinkSync(path.join(first.directory, "index.js"));
  assert.deepEqual(provisionTeamPlugin(options), first);
  fs.unlinkSync(path.join(first.directory, "index.js"));
  fs.symlinkSync(path.join(dataDir, "outside"), path.join(first.directory, "index.js"));
  assert.throws(() => provisionTeamPlugin(options), /Unsafe/);
  assert.equal(fs.existsSync(path.join(dataDir, "outside")), false);
  assert.throws(
    () => provisionTeamPlugin({ ...options, runtimeVersion: "future" }),
    /compatib/,
  );
});

test("managed plugin supports the qualified predecessor for cross-version rollback", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-plugin-previous-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  const previous = provisionTeamPlugin({ paths, runtimeVersion: "2026.9.7" });
  assert.ok(fs.existsSync(path.join(previous.directory, "workflow-tools.js")));
  assert.throws(
    () => provisionTeamPlugin({ paths, runtimeVersion: "2026.9.6" }),
    /Incompatible/,
  );
});

test("plugin compatibility follows the manifest's runtime and declared rollback targets", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-plugin-manifest-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  assert.ok(Array.isArray(runtimeManifest.rollbackTargets));
  for (const runtimeVersion of [
    runtimeManifest.version,
    ...runtimeManifest.rollbackTargets,
  ])
    assert.ok(provisionTeamPlugin({ paths, runtimeVersion }).directory);
  assert.throws(
    () =>
      provisionTeamPlugin({ paths, runtimeVersion: `${runtimeManifest.version}-next` }),
    /Incompatible/,
  );
});
test("the team proposal tool lets the model cite an explicit owner request", async () => {
  const { default: plugin } =
    await import("../../server/features/assistants/team-plugin/index.js");
  const tools = [];
  plugin.register({
    pluginConfig: undefined,
    registrationMode: "cli-metadata",
    registerTool: (tool) => tools.push(tool),
  });
  const propose = tools
    .map((tool) => tool.create({ agentId: "a", sessionKey: "s" }))
    .find((tool) => tool.name === "agentpier_team_propose");
  const { properties, required } = propose.parameters;
  assert.deepEqual(required, ["objective", "members"]);
  assert.equal(properties.ownerRequestedTeam.type, "boolean");
  assert.equal(properties.ownerRequestQuote.maxLength, 300);
  assert.match(propose.description, /verbatim/);
});
