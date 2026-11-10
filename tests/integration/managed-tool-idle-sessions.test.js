import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { craftFixture } from "../helpers/craft-tool-fixture.js";

// A session's idle MCP server never blocks an update or a removal: the new version is
// installed beside the old one, and the old folder goes once no process runs it.

const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);
const versionsOf = (f, id) =>
  fs
    .readdirSync(path.join(f.root, ".packages"))
    .filter((name) => name.startsWith(`${id}-`))
    .map((name) => path.join(f.root, ".packages", name));
// The sweep spares folders changed in the last minutes (an install in flight).
const age = (directories) => {
  for (const directory of directories) fs.utimesSync(directory, hourAgo(), hourAgo());
};

/** A fake process list the tools read; `lines` changes as processes come and go. */
function processes() {
  const list = { lines: [] };
  list.read = () => list.lines;
  return list;
}

test("an update beside an idle session's server keeps its folder until it exits", async (t) => {
  const f = await craftFixture(t);
  const ps = processes();
  const old = await f.tool({ version: "0.4.0", commandLines: ps.read });
  const { serverId } = await f.install(old, { components: { ghidra: false } });
  const [oldFolder] = versionsOf(f, "craft-anything");
  // Claude Code started the row's command (through the link) before the update.
  ps.lines = [`${f.s.servers.get(serverId).command} mcp --restricted --clean-room`];
  const craft = await f.tool({ commandLines: ps.read });
  await craft.update();
  await craft.settled();
  await craft.versions.running;
  const state = craft.state();
  assert.equal(state.status, "succeeded", state.message);
  assert.equal(state.components.core.version, "0.5.0");
  assert.deepEqual(state.components.core.runningVersions, ["0.4.0"]);
  assert.ok(fs.existsSync(oldFolder), "the running version stays");
  assert.equal(versionsOf(f, "craft-anything").length, 2);
  // New sessions get the new binary at once.
  assert.match(f.s.servers.get(serverId).command, /craft-anything-cli-0\.5\.0-/);
  // While the old server runs, a sweep keeps it.
  age([oldFolder]);
  await craft.versions.run();
  assert.ok(fs.existsSync(oldFolder));
  // The session reloaded: the next sweep removes the old folder.
  ps.lines = [];
  await craft.versions.run();
  assert.equal(fs.existsSync(oldFolder), false);
  assert.deepEqual(craft.state().components.core.runningVersions, []);
  assert.equal(craft.versions.timer, null, "nothing left to look at again");
});

test("removal with an idle session's server keeps its folder until it exits", async (t) => {
  const f = await craftFixture(t);
  const ps = processes();
  const craft = await f.tool({ commandLines: ps.read });
  const { serverId } = await f.install(craft, { components: { ghidra: false } });
  const [folder] = versionsOf(f, "craft-anything");
  ps.lines = [`${f.s.servers.get(serverId).command} mcp --restricted --deep`];
  const state = await craft.uninstall();
  await craft.versions.running;
  assert.equal(state.installed, false);
  assert.equal(fs.existsSync(path.join(f.root, "craft-anything")), false);
  assert.ok(fs.existsSync(folder), "the idle server keeps its files");
  assert.ok(craft.versions.timer, "a later sweep looks again");
  ps.lines = [];
  age([folder]);
  await craft.versions.run();
  assert.equal(fs.existsSync(folder), false);
});

test("an unreadable process list keeps every old version", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool({
    commandLines: () => {
      throw new Error("ps failed");
    },
  });
  await f.install(craft, { components: { ghidra: false } });
  const [folder] = versionsOf(f, "craft-anything");
  await craft.uninstall();
  await craft.versions.running;
  assert.ok(fs.existsSync(folder));
});

test("a shared Ghidra update leaves the version an idle server's Java runs", async (t) => {
  const f = await craftFixture(t);
  const ps = processes();
  const old = await f.tool({ pins: { ghidra: "12.0.0" }, commandLines: ps.read });
  await f.install(old);
  const ghidra = old.component("rea-ghidra");
  // Craft Anything's (or REA's) Ghidra runs in a session from the first version.
  ps.lines = [`${old.component("rea-jdk").home}/bin/java -cp ${ghidra.home}/lib`];
  const craft = await f.tool({ pins: { ghidra: "12.1.4" }, commandLines: ps.read });
  await craft.update();
  await craft.settled();
  await craft.versions.running;
  assert.equal(craft.state().status, "succeeded", craft.state().message);
  assert.equal(craft.component("rea-ghidra").version, "12.1.4");
  assert.ok(fs.existsSync(ghidra.directory), "the running Ghidra stays");
  // REA's sweep covers the shared parts too.
  const rea = await f.reaTool({ commandLines: ps.read });
  ps.lines = [];
  age(versionsOf(f, "rea-ghidra"));
  await rea.versions.run();
  assert.equal(fs.existsSync(ghidra.directory), false);
  assert.ok(craft.component("rea-ghidra"), "the active version stays");
});

test("removing Ghidra keeps the folder an idle server runs until it exits", async (t) => {
  const f = await craftFixture(t);
  const ps = processes();
  const craft = await f.tool({ commandLines: ps.read });
  await f.install(craft);
  const ghidra = craft.component("rea-ghidra");
  const jdk = craft.component("rea-jdk");
  ps.lines = [`${jdk.home}/bin/java -Dghidra.install=${ghidra.home}`];
  await f.install(craft, { components: { ghidra: false } });
  await craft.versions.running;
  assert.equal(craft.component("rea-ghidra"), null);
  assert.ok(fs.existsSync(ghidra.directory));
  assert.ok(fs.existsSync(jdk.directory));
  ps.lines = [];
  age([ghidra.directory, jdk.directory]);
  await craft.versions.run();
  assert.equal(fs.existsSync(ghidra.directory), false);
  assert.equal(fs.existsSync(jdk.directory), false);
});

test("Ghidra named only in an idle REA's environment stays", async (t) => {
  const f = await craftFixture(t);
  const ps = processes();
  const old = await f.tool({ pins: { ghidra: "12.0.0" }, commandLines: ps.read });
  await f.install(old);
  const ghidra = old.component("rea-ghidra");
  const jdk = old.component("rea-jdk");
  // An idle REA: no Java runs, only its environment names the shared folders.
  ps.lines = [
    `/node /rea/cli.js mcp GHIDRA_INSTALL_DIR=${ghidra.home} JAVA_HOME=${jdk.home}`,
  ];
  const craft = await f.tool({ pins: { ghidra: "12.1.4" }, commandLines: ps.read });
  await craft.update();
  await craft.settled();
  await craft.versions.running;
  assert.equal(craft.component("rea-ghidra").version, "12.1.4");
  assert.ok(fs.existsSync(ghidra.directory), "the folder in REA's environment stays");
  ps.lines = [];
  age(versionsOf(f, "rea-ghidra"));
  await craft.versions.run();
  assert.equal(fs.existsSync(ghidra.directory), false);
});

test("a running Craft Anything server keeps the Ghidra its config named at start", async (t) => {
  const f = await craftFixture(t);
  const ps = processes();
  const old = await f.tool({ pins: { ghidra: "12.0.0" }, commandLines: ps.read });
  await f.install(old);
  const ghidra = old.component("rea-ghidra");
  // It read config.toml at its start; only its config folder is in its environment.
  const configDir = path.join(f.s.dataDir, "craft-anything", "sessions");
  ps.lines = [`/clis/craft-anything-cli mcp CRAFT_ANYTHING_CONFIG_DIR=${configDir}`];
  const craft = await f.tool({ pins: { ghidra: "12.1.4" }, commandLines: ps.read });
  await craft.update();
  await craft.settled();
  await craft.versions.running;
  assert.ok(fs.existsSync(ghidra.directory));
  ps.lines = [];
  age(versionsOf(f, "rea-ghidra"));
  await craft.versions.run();
  assert.equal(fs.existsSync(ghidra.directory), false);
});

test("removal keeps the tool's own folder while a server's environment names it", async (t) => {
  const f = await craftFixture(t);
  const ps = processes();
  const craft = await f.tool({ commandLines: ps.read });
  await f.install(craft, { components: { ghidra: false } });
  const home = path.join(f.s.dataDir, "craft-anything");
  ps.lines = [`/x/craft-anything-cli mcp CRAFT_ANYTHING_CONFIG_DIR=${home}/sessions`];
  await craft.uninstall();
  await craft.versions.running;
  assert.ok(fs.existsSync(path.join(home, "sessions", "config.toml")), "config stays");
  ps.lines = [];
  await craft.versions.run();
  assert.equal(fs.existsSync(home), false);
});

test("no sweep runs while a job of either tool runs", async (t) => {
  const f = await craftFixture(t);
  const ps = processes();
  const old = await f.tool({ version: "0.4.0", commandLines: ps.read });
  await f.install(old, { components: { ghidra: false } });
  const [oldFolder] = versionsOf(f, "craft-anything");
  ps.lines = [`${f.s.servers.get(old.serverId()).command} mcp`];
  const craft = await f.tool({ commandLines: ps.read });
  await craft.update();
  await craft.settled();
  await craft.versions.running;
  ps.lines = [];
  age([oldFolder]);
  craft.othersBusy = () => true;
  await craft.versions.run();
  assert.ok(fs.existsSync(oldFolder), "skipped while the other tool's job runs");
  assert.ok(craft.versions.timer, "and looks again later");
  craft.othersBusy = () => false;
  await craft.versions.run();
  assert.equal(fs.existsSync(oldFolder), false);
});

/** REA and Craft Anything over one fixture, joined like the wiring joins them. */
async function bothTools(f, ps) {
  const craft = await f.tool({ commandLines: ps.read });
  const rea = await f.reaTool({ commandLines: ps.read });
  craft.keepsGhidra = () => rea.wantsGhidra();
  rea.keepsGhidra = () => craft.wantsGhidra();
  await f.reaInstall(rea, { components: { ghidra: true, frida: false } });
  await f.install(craft, { components: { ghidra: true } });
  return { craft, rea };
}

test("a removed Craft Anything kept for a running server no longer keeps Ghidra", async (t) => {
  const f = await craftFixture(t);
  const ps = processes();
  const { craft, rea } = await bothTools(f, ps);
  const home = path.join(f.s.dataDir, "craft-anything");
  ps.lines = [`/x/craft-anything-cli mcp CRAFT_ANYTHING_CONFIG_DIR=${home}/sessions`];
  await craft.uninstall();
  assert.ok(fs.existsSync(path.join(home, ".removed")), "kept for the running server");
  assert.ok(craft.component("rea-ghidra"), "REA still wants Ghidra");
  assert.equal(craft.wantsGhidra(), false, "stale settings do not count");
  await rea.uninstall();
  assert.equal(rea.component("rea-ghidra"), null, "Ghidra goes with the last tool");
  assert.equal(rea.component("rea-jdk"), null);
  // A new install takes the folder back.
  await f.install(craft, { components: { ghidra: true } });
  assert.equal(fs.existsSync(path.join(home, ".removed")), false);
  assert.equal(craft.wantsGhidra(), true);
});

test("a removed REA kept for a running server no longer keeps Ghidra", async (t) => {
  const f = await craftFixture(t);
  const ps = processes();
  const { craft, rea } = await bothTools(f, ps);
  ps.lines = [`/node /rea/cli.js mcp HOME=${path.join(f.s.dataDir, "rea", "home")}`];
  await rea.uninstall();
  assert.ok(fs.existsSync(path.join(f.s.dataDir, "rea", ".removed")));
  assert.equal(rea.wantsGhidra(), false);
  await craft.uninstall();
  assert.equal(craft.component("rea-ghidra"), null);
});
