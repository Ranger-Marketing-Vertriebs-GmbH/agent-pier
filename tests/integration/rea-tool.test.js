import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { writePrivate } from "../../server/lib/storage.js";
import { reaManagedKeys } from "../../server/features/tools/rea-environment.js";
import { installReaComponent } from "../../server/features/tools/rea-components.js";
import { provisionRea } from "../../server/features/tools/rea-provisioning.js";
import {
  fakeBinding,
  reaFixture,
  reaSkillDocument,
} from "../helpers/rea-tool-fixture.js";

const refused = (message) => ({ status: 409, message });
const linkOf = (s, id) => path.join(s.dataDir, "clis", id);

test("first install with confirmInstall creates the managed row bound to Claude Code", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  const started = await rea.apply({
    components: { ghidra: true, frida: true },
    confirmInstall: true,
  });
  assert.equal(started.status, "running");
  const state = await (await rea.settled(), rea.state());
  assert.equal(state.status, "succeeded", state.message);
  assert.equal(state.installed, true);
  assert.equal(state.updateAvailable, false);
  const server = f.s.servers.get(state.serverId);
  assert.equal(server.name, "rea");
  assert.equal(state.serverName, "rea");
  assert.deepEqual(f.s.servers.targetsOf(server.id).clis, ["claude"]);
  assert.equal(server.managed.tool, "rea");
  assert.deepEqual(server.managed.lockedEnv, [...reaManagedKeys]);
  for (const name of [
    "GHIDRA_INSTALL_DIR",
    "JAVA_HOME",
    "REA_MCP_INPUT_SCHEMA_PROFILE",
    "HOME",
  ])
    assert.ok(server.envNames.includes(name), name);
  const env = f.s.servers.envValues(server.id);
  assert.equal(env.HOME, path.join(f.s.dataDir, "rea", "home"));
  assert.equal(env.REA_MCP_INPUT_SCHEMA_PROFILE, "compact");
  assert.equal(env.GHIDRA_INSTALL_DIR, rea.component("rea-ghidra").home);
  assert.equal(env.JAVA_HOME, rea.component("rea-jdk").home);
  assert.equal(state.components.ghidra.version, "12.1.4");
  assert.equal(state.components.ghidra.jdkVersion, "21.0.13+9");
  assert.equal(state.components.core.version, "6.8.0");
  assert.equal(state.components.frida.installed, true);
  assert.equal(fs.readFileSync(f.bindingOf(server.id), "utf8"), fakeBinding);
  assert.equal(
    fs.readFileSync(path.join(f.skillCopy(), "SKILL.md"), "utf8"),
    reaSkillDocument,
  );
  // The CLI got the row as Claude Code's MCP server.
  assert.ok(f.s.saved.at(-1).claude);
  assert.deepEqual(JSON.parse(fs.readFileSync(rea.file, "utf8")), {
    serverId: server.id,
    components: { ghidra: true, frida: true },
    settings: { provider: "ghidra", hopperPath: null, idaConfig: null, jebUrl: null },
  });
  assert.equal(fs.statSync(rea.file).mode & 0o777, 0o600);
  assert.deepEqual(
    f.audits.map((event) => [event.action, event.resourceId, event.details.origin]),
    [["mcp.created", server.id, "managed"]],
  );
  assert.deepEqual(rea.utility(), {
    id: "rea",
    name: "REA",
    utility: true,
    installed: true,
    version: "6.8.0",
    pinnedVersion: "6.8.0",
    updateAvailable: false,
    status: "succeeded",
  });
});

test("install without confirmInstall is refused with 409 rea.confirmationRequired", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  await assert.rejects(
    rea.apply({ components: { ghidra: true, frida: false } }),
    refused(serverMessages.rea.confirmationRequired),
  );
  assert.equal(rea.serverId(), null);
  assert.deepEqual(f.downloads, []);
  assert.equal(rea.state().status, "idle");
});

test("an existing directory row named rea stays untouched; the managed row is rea-agentpier", async (t) => {
  const f = await reaFixture(t);
  const own = f.s.servers.create({
    name: "REA",
    transport: "stdio",
    command: f.s.executable("rea"),
    args: ["mcp"],
    env: { MY_KEY: "own" },
  });
  const rea = await f.tool();
  const state = await f.install(rea, { components: { ghidra: false, frida: false } });
  assert.equal(state.status, "succeeded", state.message);
  assert.notEqual(state.serverId, own.id);
  assert.equal(state.serverName, "rea-agentpier");
  const after = f.s.servers.get(own.id);
  assert.deepEqual(
    { ...after, envNames: after.envNames },
    { ...own, envNames: ["MY_KEY"] },
  );
  assert.equal(after.managed, undefined);
  assert.deepEqual(f.s.servers.targetsOf(own.id).clis, []);
});

test("removing Ghidra drops GHIDRA_INSTALL_DIR and JAVA_HOME and keeps the owner's own env keys", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  const { serverId } = await f.install(rea, {
    components: { ghidra: true, frida: false },
  });
  const revision = f.s.servers.get(serverId).revision;
  await f.s.changes.update(
    serverId,
    { revision, env: { MY_KEY: "own" } },
    { confirmStdio: true },
  );
  await rea.apply({ components: { ghidra: false } });
  await rea.settled();
  const state = rea.state();
  assert.equal(state.status, "succeeded", state.message);
  const env = f.s.servers.envValues(serverId);
  assert.equal(env.GHIDRA_INSTALL_DIR, undefined);
  assert.equal(env.JAVA_HOME, undefined);
  assert.equal(env.MY_KEY, "own");
  assert.equal(env.REA_MCP_INPUT_SCHEMA_PROFILE, "compact");
  assert.equal(fs.existsSync(linkOf(f.s, "rea-ghidra")), false);
  assert.equal(fs.existsSync(linkOf(f.s, "rea-jdk")), false);
  assert.equal(state.components.ghidra.installed, false);
  assert.deepEqual(f.s.servers.get(serverId).managed.lockedEnv, [...reaManagedKeys]);
});

test("turning Frida off reinstalls Core without the binding; on places it again", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  const { serverId } = await f.install(rea, {
    components: { ghidra: false, frida: true },
  });
  assert.equal(fs.existsSync(f.bindingOf(serverId)), true);
  const before = f.installCount();
  await rea.apply({ components: { frida: false } });
  await rea.settled();
  assert.equal(rea.state().status, "succeeded", rea.state().message);
  assert.equal(f.installCount(), before + 1);
  assert.equal(f.s.servers.packages.get(serverId).status, "ready");
  assert.equal(fs.existsSync(f.bindingOf(serverId)), false);
  assert.equal(rea.state().components.frida.installed, false);
  await rea.apply({ components: { frida: true } });
  await rea.settled();
  assert.equal(f.installCount(), before + 2);
  assert.equal(fs.readFileSync(f.bindingOf(serverId), "utf8"), fakeBinding);
  assert.equal(rea.state().components.frida.installed, true);
});

test("changing only bring-your-own settings updates the env without reinstalling Core", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  const { serverId } = await f.install(rea);
  const installs = f.installCount();
  const downloads = f.downloads.length;
  await rea.apply({
    settings: {
      hopperPath: "/Applications/Hopper.app/hopper",
      jebUrl: "http://127.0.0.1:9000/mcp",
    },
  });
  await rea.settled();
  assert.equal(rea.state().status, "succeeded", rea.state().message);
  assert.equal(f.installCount(), installs);
  assert.equal(f.downloads.length, downloads);
  const env = f.s.servers.envValues(serverId);
  assert.equal(env.HOPPER_LAUNCHER_PATH, "/Applications/Hopper.app/hopper");
  assert.equal(env.REA_JEB_MCP_URL, "http://127.0.0.1:9000/mcp");
  assert.ok(env.GHIDRA_INSTALL_DIR);
  assert.equal(rea.state().settings.hopperPath, "/Applications/Hopper.app/hopper");
  // Invalid settings are refused before anything runs.
  await assert.rejects(rea.apply({ settings: { hopperPath: "relative" } }), {
    status: 400,
    message: serverMessages.rea.invalidPath,
  });
});

test("start() installs what --with-rea requested and clears the request", async (t) => {
  const f = await reaFixture(t);
  writePrivate(path.join(f.s.dataDir, "rea", "settings.json"), {
    requested: { components: { ghidra: true, frida: true }, settings: {} },
  });
  const rea = await f.tool();
  await rea.start();
  const state = rea.state();
  assert.equal(state.status, "succeeded", state.message);
  assert.equal(state.installed, true);
  assert.equal(state.components.ghidra.installed, true);
  assert.equal(fs.existsSync(f.bindingOf(state.serverId)), true);
  const saved = JSON.parse(fs.readFileSync(rea.file, "utf8"));
  assert.equal(saved.requested, undefined);
  assert.equal(f.audits.at(-1).source, "system");
});

test("start() brings an outdated Ghidra, JDK or Core lock to the pins", async (t) => {
  const f = await reaFixture(t);
  const old = await f.tool({ pins: { ghidra: "12.1.3", jdk: "21.0.12+7" } });
  const { serverId } = await f.install(old);
  await old.close();
  assert.equal(old.component("rea-ghidra").version, "12.1.3");
  // A newer AgentPier pins newer components and Core.
  const rea = await f.tool({ coreVersion: "6.9.0" });
  assert.equal(rea.state().updateAvailable, true);
  assert.equal(rea.state().components.core.outdated, true);
  assert.equal(rea.state().components.ghidra.outdated, true);
  assert.equal(rea.utility().updateAvailable, true);
  await rea.start();
  const state = rea.state();
  assert.equal(state.status, "succeeded", state.message);
  assert.equal(state.updateAvailable, false);
  assert.equal(state.components.core.outdated, false);
  assert.equal(state.components.ghidra.outdated, false);
  assert.equal(state.serverId, serverId);
  assert.equal(state.components.ghidra.version, "12.1.4");
  assert.equal(state.components.ghidra.jdkVersion, "21.0.13+9");
  assert.equal(state.components.core.version, "6.9.0");
  assert.equal(f.s.servers.packages.get(serverId).version, "6.9.0");
  // The update kept frida's binding and points the env at the new homes.
  assert.equal(fs.readFileSync(f.bindingOf(serverId), "utf8"), fakeBinding);
  const env = f.s.servers.envValues(serverId);
  assert.equal(env.GHIDRA_INSTALL_DIR, rea.component("rea-ghidra").home);
  assert.equal(env.JAVA_HOME, rea.component("rea-jdk").home);
});

// The installer (--with-rea, provisionRea) switches the component links to the new
// pins before the server starts, so start() finds nothing outdated: the row's env
// must still follow the links, or it names a version folder the next bump prunes.
test("start() points the row env at the homes an installer update switched to", async (t) => {
  const f = await reaFixture(t);
  const old = await f.tool({ pins: { ghidra: "12.1.2", jdk: "21.0.11+9" } });
  const { serverId } = await f.install(old);
  const first = old.component("rea-ghidra").directory;
  await old.close();
  const installer = async (pins) => {
    const result = await provisionRea(
      { dataDir: f.s.dataDir, manifest: f.manifest(pins), platform: "darwin" },
      {
        fetchImpl: f.fetchImpl,
        install: (options) => installReaComponent({ ...options, run: f.run, env: {} }),
      },
    );
    assert.equal(result.status, "ready", result.message);
  };
  const env = () => f.s.servers.envValues(serverId);
  for (const [index, pins] of [
    { ghidra: "12.1.3", jdk: "21.0.12+7" },
    { ghidra: "12.1.4", jdk: "21.0.13+9" },
  ].entries()) {
    await installer(pins);
    const rea = await f.tool({ pins });
    assert.equal(rea.state().updateAvailable, false);
    f.busy.value = index === 1;
    await rea.start();
    assert.equal(rea.state().status, "idle");
    assert.equal(env().GHIDRA_INSTALL_DIR, rea.component("rea-ghidra").home);
    assert.equal(env().JAVA_HOME, rea.component("rea-jdk").home);
    assert.equal(fs.existsSync(env().GHIDRA_INSTALL_DIR), true);
    assert.equal(fs.existsSync(env().JAVA_HOME), true);
    await rea.close();
  }
  // The second bump pruned the first version; the env never names it.
  assert.equal(fs.existsSync(first), false);
  f.busy.value = false;
});

test("start() skips the update while REA is in use and reports updateAvailable", async (t) => {
  const f = await reaFixture(t);
  const old = await f.tool({ pins: { ghidra: "12.1.3" } });
  await f.install(old);
  await old.close();
  // Only Ghidra and the JDK are behind: Core is not named as outdated.
  const pinsOnly = await f.tool();
  assert.equal(pinsOnly.state().components.core.outdated, false);
  assert.equal(pinsOnly.state().components.ghidra.outdated, true);
  await pinsOnly.close();
  const rea = await f.tool({ coreVersion: "6.9.0" });
  f.busy.value = true;
  await rea.start();
  const state = rea.state();
  assert.equal(state.status, "idle");
  assert.equal(state.updateAvailable, true);
  assert.equal(state.components.ghidra.version, "12.1.3");
  assert.equal(state.components.core.version, "6.8.0");
  // The next start without a running REA updates.
  f.busy.value = false;
  await rea.start();
  assert.equal(rea.state().updateAvailable, false);
});

test("uninstall, Ghidra removal and Frida off are refused while in use (409 rea.inUse)", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  const { serverId } = await f.install(rea);
  f.busy.value = true;
  const inUse = refused(serverMessages.rea.inUse);
  await assert.rejects(rea.uninstall(), inUse);
  await assert.rejects(rea.apply({ components: { ghidra: false } }), inUse);
  await assert.rejects(rea.apply({ components: { frida: false } }), inUse);
  await assert.rejects(rea.update(), inUse);
  assert.equal(rea.serverId(), serverId);
  assert.ok(rea.component("rea-ghidra"));
  assert.equal(fs.existsSync(f.bindingOf(serverId)), true);
  // Settings that replace no file still apply.
  await rea.apply({ settings: { jebUrl: "http://127.0.0.1:9000/mcp" } });
  await rea.settled();
  assert.equal(rea.state().status, "succeeded", rea.state().message);
});

test("uninstall removes the row, skill copies, Ghidra, JDK and <data>/rea", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  const { serverId } = await f.install(rea);
  assert.equal(fs.existsSync(f.skillCopy()), true);
  const state = await rea.uninstall();
  assert.equal(state.installed, false);
  assert.equal(state.serverId, null);
  assert.equal(rea.serverId(), null);
  assert.equal(f.s.servers.list().length, 0);
  assert.equal(fs.existsSync(f.skillCopy()), false);
  assert.deepEqual(f.s.extensions.installed(), []);
  assert.equal(fs.existsSync(linkOf(f.s, "rea-ghidra")), false);
  assert.equal(fs.existsSync(linkOf(f.s, "rea-jdk")), false);
  assert.deepEqual(fs.readdirSync(path.join(f.s.dataDir, "clis", ".packages")), []);
  assert.equal(fs.existsSync(path.join(f.s.dataDir, "rea")), false);
  assert.deepEqual(
    f.audits.map((event) => [event.action, event.resourceId, event.details.origin]),
    [
      ["mcp.created", serverId, "managed"],
      ["mcp.deleted", serverId, "managed"],
    ],
  );
  // Nothing left: a second uninstall is a no-op.
  assert.equal((await rea.uninstall()).installed, false);
});

test("a managed row whose Core is gone can be removed, or reinstalled as the one row", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  const { serverId } = await f.install(rea, {
    components: { ghidra: false, frida: false },
  });
  // A restored backup without the install folder.
  const row = f.s.servers.packages.get(serverId);
  fs.rmSync(path.join(f.s.dataDir, "mcp-packages", "installs", row.installId), {
    recursive: true,
  });
  assert.equal(rea.state().installed, false);
  assert.equal(rea.state().components.core.packageStatus, "missing");
  // Applying again reinstalls into the same row; no second managed row appears.
  await rea.apply({});
  await rea.settled();
  assert.equal(rea.state().installed, true, rea.state().message);
  assert.equal(rea.serverId(), serverId);
  assert.equal(f.s.servers.list().filter((server) => server.managed).length, 1);
  fs.rmSync(
    path.join(
      f.s.dataDir,
      "mcp-packages",
      "installs",
      f.s.servers.packages.get(serverId).installId,
    ),
    { recursive: true },
  );
  // The card removes it while REA is not installed.
  assert.equal(rea.state().installed, false);
  await rea.uninstall();
  assert.equal(f.s.servers.list().length, 0);
});

test("a second apply while a job runs is refused (409 rea.busy)", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  const held = f.s.hold();
  await rea.apply({ components: { ghidra: false, frida: false }, confirmInstall: true });
  await held.reached;
  const busy = refused(serverMessages.rea.busy);
  assert.equal(rea.state().status, "running");
  assert.equal(rea.state().step, "core");
  await assert.rejects(rea.apply({ settings: {} }), busy);
  await assert.rejects(rea.uninstall(), busy);
  await assert.rejects(rea.update(), busy);
  held.release();
  await rea.settled();
  assert.equal(rea.state().status, "succeeded", rea.state().message);
});

test("a platform without REA reports available false and refuses apply", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool({ platform: "win32", arch: "x64" });
  const state = rea.state();
  assert.equal(state.available, false);
  assert.equal(state.reason, serverMessages.rea.platformUnavailable);
  await assert.rejects(
    rea.apply({ confirmInstall: true }),
    refused(serverMessages.rea.platformUnavailable),
  );
  // Ghidra is refused where it has no download; Core and frida stay possible.
  const intel = await f.tool({ arch: "x64" });
  assert.equal(intel.state().components.ghidra.available, false);
  await assert.rejects(
    intel.apply({ components: { ghidra: true }, confirmInstall: true }),
    refused(serverMessages.rea.ghidraIntelMac),
  );
  assert.equal(f.s.servers.list().length, 0);
});

test("start() sweeps interrupted REA installs, never while a job runs", async (t) => {
  const f = await reaFixture(t);
  const leftover = (name) => path.join(f.s.dataDir, "clis", name);
  fs.mkdirSync(leftover(".rea-install-old"), { recursive: true });
  const rea = await f.tool();
  await rea.start();
  assert.equal(fs.existsSync(leftover(".rea-install-old")), false);
  const held = f.s.hold();
  await rea.apply({ components: { ghidra: false, frida: false }, confirmInstall: true });
  await held.reached;
  fs.mkdirSync(leftover(".rea-install-running"));
  await rea.start();
  assert.equal(fs.existsSync(leftover(".rea-install-running")), true);
  held.release();
  await rea.settled();
  // Nor while a refusal check holds the job slot.
  rea.claimed = true;
  await rea.start();
  assert.equal(fs.existsSync(leftover(".rea-install-running")), true);
  rea.claimed = false;
});

test("close() stops a running download through the job's signal", async (t) => {
  const f = await reaFixture(t);
  let started;
  const reached = new Promise((resolve) => (started = resolve));
  const rea = await f.tool({
    // A download that only ends when its signal aborts.
    fetchImpl: (_url, options) =>
      new Promise((_resolve, reject) => {
        started();
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      }),
  });
  await rea.apply({ components: { ghidra: true, frida: false }, confirmInstall: true });
  await reached;
  assert.equal(rea.state().step, "jdk");
  await rea.close();
  assert.equal(rea.state().status, "failed");
  assert.equal(rea.serverId(), null);
  assert.equal(rea.component("rea-jdk"), null);
});

test("a --with-rea request survives a stop mid-download and the next start retries it", async (t) => {
  const f = await reaFixture(t);
  const file = path.join(f.s.dataDir, "rea", "settings.json");
  writePrivate(file, {
    requested: { components: { ghidra: true, frida: false }, settings: {} },
  });
  let started;
  const reached = new Promise((resolve) => (started = resolve));
  const stopped = await f.tool({
    fetchImpl: (_url, options) =>
      new Promise((_resolve, reject) => {
        started();
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
      }),
  });
  const starting = stopped.start();
  await reached;
  await stopped.close();
  await starting;
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).requested);
  assert.equal(stopped.serverId(), null);
  // The next AgentPier start installs it and only then drops the request.
  const rea = await f.tool();
  await rea.start();
  assert.equal(rea.state().installed, true, rea.state().message);
  assert.equal(rea.state().components.ghidra.installed, true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).requested, undefined);
});

test("a --with-rea request that really fails is cleared and the card shows why", async (t) => {
  const f = await reaFixture(t);
  const file = path.join(f.s.dataDir, "rea", "settings.json");
  writePrivate(file, {
    requested: { components: { ghidra: true, frida: false }, settings: {} },
  });
  const rea = await f.tool();
  rea.manifest.jdk.platforms["darwin-arm64"].sha256 = "0".repeat(64);
  await rea.start();
  const state = rea.state();
  assert.equal(state.status, "failed");
  assert.equal(state.message, serverMessages.rea.checksumMismatch);
  assert.equal(state.messageKey, "rea.checksumMismatch");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).requested, undefined);
});

test("the managed row takes a numbered name when rea and rea-agentpier are the owner's", async (t) => {
  const f = await reaFixture(t);
  for (const name of ["rea", "REA-AgentPier"])
    f.s.servers.create({ name, transport: "stdio", command: "/fake/bin/rea", args: [] });
  const rea = await f.tool();
  const state = await f.install(rea, { components: { ghidra: false, frida: false } });
  assert.equal(state.serverName, "rea-agentpier-2", state.message);
});

test("a fault reading REA degrades only REA's utility row", async (t) => {
  const f = await reaFixture(t);
  const rea = await f.tool();
  rea.packages = {
    ...rea.packages,
    records: {
      get: () => {
        throw new Error("store gone");
      },
    },
  };
  f.s.servers.create(
    { name: "rea", transport: "stdio", command: "/fake/bin/rea", args: [] },
    { managed: { tool: "rea" } },
  );
  const row = rea.utility();
  assert.equal(row.id, "rea");
  assert.equal(row.installed, false);
  assert.equal(row.status, "failed");
});
