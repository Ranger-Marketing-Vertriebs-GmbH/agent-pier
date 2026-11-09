import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { writePrivate } from "../../server/lib/storage.js";
import { installReaComponent } from "../../server/features/tools/rea-components.js";
import { reaPlatform } from "../../server/features/tools/rea-manifest.js";
import { craftBinaryPath } from "../../server/features/tools/craft-manifest.js";
import {
  craftEnvironment,
  craftManagedKeys,
} from "../../server/features/tools/craft-config.js";
import { requireOwnerPatch } from "../../server/features/mcp-servers/managed-servers.js";
import { managedRowInUse, reaInUse } from "../../server/application/rea-wiring.js";
import { createCraftTool } from "../../server/application/craft-wiring.js";
import { RebuildStore } from "../../server/features/craft/rebuild-store.js";
import { craftFixture } from "../helpers/craft-tool-fixture.js";

const refused = (message) => ({ status: 409, message });
const linkOf = (f, id) => path.join(f.root, id);
const baseArgs = ["mcp", "--restricted", "--allow-web", "--allow-capture"];
const craftDownload = (version) =>
  `github.com/storytold/craft-anything/releases/download/v${version}/craft-anything-cli-${version}-macos-universal.zip`;
const config = (f) => parse(fs.readFileSync(f.configFile, "utf8"));

test("first install needs confirmInstall", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool();
  await assert.rejects(
    craft.apply({ components: { ghidra: false } }),
    refused(serverMessages.craft.confirmationRequired),
  );
  assert.equal(craft.serverId(), null);
  assert.deepEqual(f.downloads, []);
  assert.equal(craft.state().status, "idle");
});

test("first install places the binary and creates a managed row bound to Claude", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool();
  const started = await craft.apply({
    components: { ghidra: false },
    confirmInstall: true,
  });
  assert.equal(started.status, "running");
  await craft.settled();
  const state = craft.state();
  assert.equal(state.status, "succeeded", state.message);
  assert.equal(state.installed, true);
  assert.equal(state.updateAvailable, false);
  const server = f.s.servers.get(state.serverId);
  assert.equal(server.transport, "stdio");
  assert.equal(server.name, "craft-anything");
  assert.equal(state.serverName, "craft-anything");
  const entry = craft.manifest.platforms["darwin-arm64"];
  assert.equal(server.command, craftBinaryPath(f.root, entry));
  assert.ok(server.command.startsWith(linkOf(f, "craft-anything") + path.sep));
  fs.accessSync(server.command, fs.constants.X_OK);
  assert.equal(server.managed.tool, "craft-anything");
  assert.deepEqual(server.managed.lockedEnv, [...craftManagedKeys]);
  assert.deepEqual(f.s.servers.targetsOf(server.id).clis, ["claude"]);
  assert.deepEqual(state.components.core, {
    installed: true,
    version: "0.5.0",
    pinnedVersion: "0.5.0",
    downloadSize: entry.size,
    installedSize: entry.installedSize,
    outdated: false,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(craft.file, "utf8")), {
    serverId: server.id,
    components: { ghidra: false },
    settings: { mode: "clean-room" },
  });
  assert.equal(fs.statSync(craft.file).mode & 0o777, 0o600);
  assert.deepEqual(
    f.audits.map((event) => [event.action, event.resourceId, event.details.origin]),
    [["mcp.created", server.id, "managed"]],
  );
  assert.deepEqual(craft.utility(), {
    id: "craft-anything",
    name: "Craft Anything",
    utility: true,
    installed: true,
    version: "0.5.0",
    pinnedVersion: "0.5.0",
    updateAvailable: false,
    status: "succeeded",
  });
  // The tool's own row fields stay locked against owner patches.
  assert.throws(() => requireOwnerPatch(f.s.servers, server.id, { args: [] }), {
    status: 409,
  });
  assert.throws(() => requireOwnerPatch(f.s.servers, server.id, { command: "/bin/sh" }), {
    status: 409,
  });
});

test("row args", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool();
  const { serverId } = await f.install(craft, { components: { ghidra: false } });
  assert.deepEqual(f.s.servers.get(serverId).args, [...baseArgs, "--clean-room"]);
  assert.deepEqual(f.s.servers.envValues(serverId), craftEnvironment(f.s.dataDir));
  await craft.apply({ settings: { mode: "deep" } });
  await craft.settled();
  assert.equal(craft.state().status, "succeeded", craft.state().message);
  assert.deepEqual(f.s.servers.get(serverId).args, [...baseArgs, "--deep"]);
  assert.deepEqual(craft.state().settings, { mode: "deep" });
  assert.deepEqual(f.s.servers.envValues(serverId), craftEnvironment(f.s.dataDir));
  assert.deepEqual(f.s.servers.get(serverId).managed.lockedEnv, [...craftManagedKeys]);
  await assert.rejects(craft.apply({ settings: { mode: "auto" } }), {
    status: 400,
    message: serverMessages.craft.invalidMode,
  });
  // An agent flips Craft Anything's own settings; the next start resets AgentPier's.
  const revision = f.s.servers.get(serverId).revision;
  await f.s.changes.update(
    serverId,
    {
      revision,
      args: [...baseArgs],
      env: { CRAFT_ANYTHING_NO_KEYCHAIN: "0", OWN: "x" },
    },
    { confirmStdio: true },
  );
  await craft.start();
  assert.deepEqual(f.s.servers.get(serverId).args, [...baseArgs, "--deep"]);
  assert.deepEqual(f.s.servers.envValues(serverId), {
    ...craftEnvironment(f.s.dataDir),
    OWN: "x",
  });
});

test("name collision gives craft-anything-agentpier", async (t) => {
  const f = await craftFixture(t);
  const own = f.s.servers.create({
    name: "Craft-Anything",
    transport: "stdio",
    command: f.s.executable("craft"),
    args: ["mcp"],
  });
  const craft = await f.tool();
  const state = await f.install(craft, { components: { ghidra: false } });
  assert.equal(state.status, "succeeded", state.message);
  assert.notEqual(state.serverId, own.id);
  assert.equal(state.serverName, "craft-anything-agentpier");
  assert.equal(f.s.servers.get(own.id).managed, undefined);
});

test("reuses REA's Ghidra and JDK", async (t) => {
  const f = await craftFixture(t);
  const host = reaPlatform(
    { platform: "darwin", arch: "arm64", darwinMajor: 25 },
    f.manifest(),
  );
  const pins = f.manifest();
  for (const [id, entry, version] of [
    ["rea-jdk", host.ghidra.jdk, pins.jdk.version],
    ["rea-ghidra", host.ghidra.entry, pins.ghidra.version],
  ])
    await installReaComponent({
      root: f.root,
      id,
      version,
      entry,
      fetchImpl: f.fetchImpl,
      run: f.run,
      env: {},
      platform: "darwin",
    });
  f.downloads.length = 0;
  const craft = await f.tool();
  craft.keepsGhidra = () => true;
  const state = await f.install(craft, { components: { ghidra: true } });
  assert.equal(state.status, "succeeded", state.message);
  assert.deepEqual(f.downloads, [craftDownload("0.5.0")]);
  assert.equal(state.components.ghidra.installed, true);
  assert.equal(state.components.ghidra.shared, true);
  const engine = config(f).engines.ghidra;
  assert.equal(engine.install_dir, craft.component("rea-ghidra").home);
  assert.equal(engine.java_home, craft.component("rea-jdk").home);
  craft.keepsGhidra = () => false;
  assert.equal(craft.state().components.ghidra.shared, false);
});

test("installs Ghidra when nobody has it", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool();
  const state = await f.install(craft);
  assert.equal(state.status, "succeeded", state.message);
  assert.ok(fs.lstatSync(linkOf(f, "rea-ghidra")).isSymbolicLink());
  assert.ok(fs.lstatSync(linkOf(f, "rea-jdk")).isSymbolicLink());
  assert.equal(state.components.ghidra.installed, true);
  assert.equal(state.components.ghidra.shared, false);
  assert.equal(state.components.ghidra.version, "12.1.4");
  assert.equal(craft.wantsGhidra(), true);
  const parsed = config(f);
  assert.equal(parsed.auto_mode, false);
  assert.equal(parsed.deep_mode, false);
  assert.equal(parsed.engines.ghidra.install_dir, craft.component("rea-ghidra").home);
  assert.equal(parsed.engines.ghidra.java_home, craft.component("rea-jdk").home);
  // Turning Ghidra off removes it (nobody else keeps it) and points at the stub.
  await craft.apply({ components: { ghidra: false } });
  await craft.settled();
  assert.equal(craft.state().status, "succeeded", craft.state().message);
  assert.equal(fs.existsSync(linkOf(f, "rea-ghidra")), false);
  assert.equal(fs.existsSync(linkOf(f, "rea-jdk")), false);
  assert.equal(craft.wantsGhidra(), false);
  const engine = config(f).engines.ghidra;
  assert.equal(engine.install_dir, path.join(f.s.dataDir, "craft-anything", "no-ghidra"));
  assert.equal(engine.java_home, undefined);
});

test("linux-arm64 installs without Ghidra", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool({ platform: "linux", arch: "arm64" });
  const before = craft.state();
  assert.equal(before.available, true);
  assert.equal(before.components.ghidra.available, false);
  assert.equal(before.components.ghidra.reason, serverMessages.rea.ghidraLinuxArm64);
  await assert.rejects(
    craft.apply({ components: { ghidra: true }, confirmInstall: true }),
    refused(serverMessages.rea.ghidraLinuxArm64),
  );
  const state = await f.install(craft, { components: { ghidra: false } });
  assert.equal(state.status, "succeeded", state.message);
  const server = f.s.servers.get(state.serverId);
  assert.equal(
    server.command,
    craftBinaryPath(f.root, craft.manifest.platforms["linux-arm64"]),
  );
  const engine = config(f).engines.ghidra;
  assert.equal(engine.install_dir, path.join(f.s.dataDir, "craft-anything", "no-ghidra"));
  assert.equal(engine.java_home, undefined);
});

test("a host without Craft Anything reports available false and refuses apply", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool({ platform: "win32", arch: "x64" });
  const state = craft.state();
  assert.equal(state.available, false);
  assert.equal(state.reason, serverMessages.craft.platformUnavailable);
  await assert.rejects(
    craft.apply({ confirmInstall: true }),
    refused(serverMessages.craft.platformUnavailable),
  );
});

test("update brings the binary to the pin", async (t) => {
  const f = await craftFixture(t);
  const old = await f.tool({ version: "0.4.0" });
  const { serverId } = await f.install(old, { components: { ghidra: false } });
  assert.equal(old.state().components.core.version, "0.4.0");
  const craft = await f.tool();
  const state = craft.state();
  assert.equal(state.updateAvailable, true);
  assert.equal(state.components.core.outdated, true);
  assert.equal(state.components.core.version, "0.4.0");
  assert.equal(craft.utility().updateAvailable, true);
  // The row still runs the installed 0.4.0 binary until the update.
  assert.equal(
    f.s.servers.get(serverId).command,
    craftBinaryPath(f.root, old.manifest.platforms["darwin-arm64"]),
  );
  await craft.update();
  await craft.settled();
  const after = craft.state();
  assert.equal(after.status, "succeeded", after.message);
  assert.equal(after.components.core.version, "0.5.0");
  assert.equal(after.updateAvailable, false);
  const command = f.s.servers.get(serverId).command;
  assert.equal(
    command,
    craftBinaryPath(f.root, craft.manifest.platforms["darwin-arm64"]),
  );
  fs.accessSync(command, fs.constants.X_OK);
  assert.deepEqual(f.s.servers.get(serverId).args, [...baseArgs, "--clean-room"]);
});

test("update is refused while in use or not installed", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool();
  await assert.rejects(craft.update(), refused(serverMessages.craft.notInstalled));
  await f.install(craft, { components: { ghidra: false } });
  f.busy.value = true;
  await assert.rejects(craft.update(), refused(serverMessages.craft.inUse));
  await assert.rejects(craft.uninstall(), refused(serverMessages.craft.inUse));
});

test("a second apply while a job runs is refused", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool();
  await craft.apply({ components: { ghidra: false }, confirmInstall: true });
  await assert.rejects(craft.apply({}), refused(serverMessages.craft.busy));
  await craft.settled();
});

test("uninstall removes row, binary and its skill copies; keeps Ghidra when keepsGhidra()", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool();
  const skills = [];
  craft.syncSkills = async (serverId) => skills.push(serverId);
  const { serverId } = await f.install(craft);
  assert.deepEqual(skills, [serverId]);
  craft.keepsGhidra = () => true;
  // The rebuild list lives outside the tool's directory and survives it.
  const rebuilds = new RebuildStore(f.s.dataDir);
  rebuilds.save({
    settings: {},
    records: [{ id: "r1", folder: "/x", request: "x", accountId: "a" }],
  });
  const state = await craft.uninstall();
  assert.equal(rebuilds.load().records.length, 1);
  assert.equal(state.installed, false);
  assert.equal(state.serverId, null);
  assert.equal(f.s.servers.definitions().length, 0);
  assert.deepEqual(skills, [serverId, null]);
  assert.equal(fs.existsSync(linkOf(f, "craft-anything")), false);
  assert.equal(fs.existsSync(path.join(f.s.dataDir, "craft-anything")), false);
  assert.ok(craft.component("rea-ghidra"));
  assert.ok(craft.component("rea-jdk"));
  assert.ok(f.audits.some((event) => event.action === "mcp.deleted"));
  // Without anyone keeping it, Ghidra goes with the next uninstall.
  const again = await f.tool();
  await f.install(again);
  again.keepsGhidra = () => false;
  await again.uninstall();
  assert.equal(fs.existsSync(linkOf(f, "rea-ghidra")), false);
  assert.equal(fs.existsSync(linkOf(f, "rea-jdk")), false);
});

test("start() applies a requested install once and clears the request", async (t) => {
  const f = await craftFixture(t);
  writePrivate(path.join(f.s.dataDir, "craft-anything", "settings.json"), {
    requested: { components: { ghidra: false }, settings: { mode: "deep" } },
  });
  const craft = await f.tool();
  await craft.start();
  const state = craft.state();
  assert.equal(state.status, "succeeded", state.message);
  assert.equal(state.installed, true);
  assert.deepEqual(state.settings, { mode: "deep" });
  assert.equal(craft.stored().requested, null);
  assert.deepEqual(f.s.servers.get(state.serverId).args, [...baseArgs, "--deep"]);
  const jobs = craft.jobCount;
  await craft.start();
  assert.equal(craft.jobCount, jobs);
});

test("start() updates an outdated, unused install", async (t) => {
  const f = await craftFixture(t);
  const old = await f.tool({ version: "0.4.0" });
  await f.install(old, { components: { ghidra: false } });
  const busy = await f.tool();
  f.busy.value = true;
  await busy.start();
  assert.equal(busy.state().components.core.version, "0.4.0");
  assert.equal(busy.state().updateAvailable, true);
  f.busy.value = false;
  const craft = await f.tool();
  await craft.start();
  const state = craft.state();
  assert.equal(state.components.core.version, "0.5.0");
  assert.equal(state.updateAvailable, false);
  assert.equal(
    f.s.servers.get(state.serverId).command,
    craftBinaryPath(f.root, craft.manifest.platforms["darwin-arm64"]),
  );
});

test("config is rewritten at start", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool();
  await f.install(craft, { components: { ghidra: false } });
  fs.writeFileSync(
    f.configFile,
    'auto_mode = true\ndeep_mode = true\nask_before_running = false\n[engines.ghidra]\ninstall_dir = "/elsewhere"\njava_home = "/jdk"\n',
  );
  await craft.start();
  const parsed = config(f);
  assert.equal(parsed.auto_mode, false);
  assert.equal(parsed.deep_mode, false);
  assert.equal(parsed.ask_before_running, false);
  assert.equal(
    parsed.engines.ghidra.install_dir,
    path.join(f.s.dataDir, "craft-anything", "no-ghidra"),
  );
  assert.equal(parsed.engines.ghidra.java_home, undefined);
});

test("close() stops a running download through the job's signal", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool({
    fetchImpl: (url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  });
  await craft.apply({ components: { ghidra: false }, confirmInstall: true });
  await craft.close();
  assert.equal(craft.state().status, "failed");
  assert.equal(craft.aborted, true);
  assert.equal(craft.serverId(), null);
});

test("running rebuilds keep Craft Anything in use; idle children close first", async (t) => {
  const f = await craftFixture(t);
  let busy = true;
  let closed = 0;
  const craft = createCraftTool({
    config: { dataDir: f.s.dataDir },
    servers: f.s.servers,
    changes: f.s.changes,
    packages: f.s.packages,
    extensions: f.s.extensions,
    audit: { append() {} },
    sessions: { list: async () => [] },
    services: () => ({
      craftRebuilds: { inUse: () => busy, closeIdle: async () => closed++ },
    }),
  });
  t.after(() => craft.close());
  assert.equal(await craft.inUse(), true);
  assert.equal(closed, 0);
  busy = false;
  assert.equal(await craft.inUse(), false);
  assert.equal(closed, 1, "the idle children closed before a change");
});

test("managedRowInUse is the generic check REA's name points at", () => {
  assert.equal(reaInUse, managedRowInUse);
});

test("overlapping environment syncs and an apply do not race on the row", async (t) => {
  const f = await craftFixture(t);
  const craft = await f.tool();
  const { serverId } = await f.install(craft, { components: { ghidra: false } });
  // An agent flipped the row: every sync has something to patch.
  await f.s.changes.update(
    serverId,
    { revision: f.s.servers.get(serverId).revision, args: [...baseArgs] },
    { confirmStdio: true },
  );
  // Saving goes through the agents' gateway in production: it takes a while.
  const save = f.s.changes.update.bind(f.s.changes);
  f.s.changes.update = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return save(...args);
  };
  const syncs = [craft.syncEnvironment(), craft.syncEnvironment()];
  await craft.apply({ settings: { mode: "deep" } });
  await Promise.all(syncs);
  await craft.settled();
  assert.equal(craft.state().status, "succeeded", craft.state().message);
  assert.deepEqual(f.s.servers.get(serverId).args, [...baseArgs, "--deep"]);
});
