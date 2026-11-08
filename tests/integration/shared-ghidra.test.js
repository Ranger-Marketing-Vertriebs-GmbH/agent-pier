import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { craftFixture } from "../helpers/craft-tool-fixture.js";

const refused = (message) => ({ status: 409, message });
const linkOf = (f, id) => path.join(f.root, id);
const stub = (f) => path.join(f.s.dataDir, "craft-anything", "no-ghidra");

/**
 * REA and Craft Anything on one data dir, their hooks joined as the wiring joins
 * them. `busy.rea`/`busy.craft` say whether a session runs the tool.
 */
async function pair(t, { pins } = {}) {
  const f = await craftFixture(t);
  const busy = { rea: false, craft: false };
  const rea = await f.reaTool({ pins });
  const craft = await f.tool({ pins });
  rea.inUse = async () => busy.rea;
  craft.inUse = async () => busy.craft;
  const join = (one, other) => {
    one.keepsGhidra = () => other.wantsGhidra();
    one.othersUseGhidra = async () => (await other.inUse()) && other.wantsGhidra();
    one.othersBusy = () => !!other.job || other.claimed;
  };
  join(rea, craft);
  join(craft, rea);
  const installBoth = async () => {
    const reaState = await f.reaInstall(rea, {
      components: { ghidra: true, frida: false },
    });
    assert.equal(reaState.status, "succeeded", reaState.message);
    const craftState = await f.install(craft, { components: { ghidra: true } });
    assert.equal(craftState.status, "succeeded", craftState.message);
  };
  return { f, rea, craft, busy, installBoth };
}

const present = (f) =>
  fs.existsSync(linkOf(f, "rea-ghidra")) && fs.existsSync(linkOf(f, "rea-jdk"));

test("REA turning Ghidra off keeps it while Craft Anything wants it", async (t) => {
  const { f, rea, craft, busy, installBoth } = await pair(t);
  await installBoth();
  const ghidra = rea.component("rea-ghidra").directory;
  // Nothing goes, so REA's own running session does not refuse the change.
  busy.rea = true;
  await rea.apply({ components: { ghidra: false } });
  await rea.settled();
  assert.equal(rea.state().status, "succeeded", rea.state().message);
  assert.ok(present(f));
  assert.equal(craft.component("rea-ghidra").directory, ghidra);
  assert.equal(rea.wantsGhidra(), false);
  assert.equal(rea.stored().components.ghidra, false);
  const env = f.s.servers.envValues(rea.serverId());
  assert.equal(env.GHIDRA_INSTALL_DIR, undefined);
  assert.equal(env.JAVA_HOME, undefined);
  // A later start keeps REA's row without Ghidra.
  await rea.start();
  assert.equal(f.s.servers.envValues(rea.serverId()).GHIDRA_INSTALL_DIR, undefined);
  assert.equal(
    parse(fs.readFileSync(f.configFile, "utf8")).engines.ghidra.install_dir,
    craft.component("rea-ghidra").home,
  );
});

test("uninstalling REA keeps Ghidra for Craft Anything", async (t) => {
  const { f, rea, craft, installBoth } = await pair(t);
  await installBoth();
  await rea.uninstall();
  assert.equal(rea.serverId(), null);
  assert.equal(fs.existsSync(rea.directory), false);
  assert.ok(present(f));
  assert.equal(craft.state().components.ghidra.installed, true);
  assert.equal(craft.state().components.ghidra.shared, false);
});

test("uninstalling Craft Anything keeps Ghidra for REA", async (t) => {
  const { f, rea, craft, installBoth } = await pair(t);
  await installBoth();
  await craft.uninstall();
  assert.equal(craft.serverId(), null);
  assert.ok(present(f));
  assert.equal(rea.state().components.ghidra.installed, true);
  const env = f.s.servers.envValues(rea.serverId());
  assert.equal(env.GHIDRA_INSTALL_DIR, rea.component("rea-ghidra").home);
});

test("the last user removes Ghidra and the JDK", async (t) => {
  const { f, rea, craft, installBoth } = await pair(t);
  await installBoth();
  // Craft Anything turns Ghidra off: REA keeps it, and Craft's config uses the stub.
  await craft.apply({ components: { ghidra: false } });
  await craft.settled();
  assert.equal(craft.state().status, "succeeded", craft.state().message);
  assert.ok(present(f));
  const engine = parse(fs.readFileSync(f.configFile, "utf8")).engines.ghidra;
  assert.equal(engine.install_dir, stub(f));
  assert.equal(engine.java_home, undefined);
  // REA, the last user, turns it off: both go.
  await rea.apply({ components: { ghidra: false } });
  await rea.settled();
  assert.equal(rea.state().status, "succeeded", rea.state().message);
  assert.equal(fs.existsSync(linkOf(f, "rea-ghidra")), false);
  assert.equal(fs.existsSync(linkOf(f, "rea-jdk")), false);
  assert.deepEqual(
    fs
      .readdirSync(path.join(f.root, ".packages"))
      .filter((name) => name.startsWith("rea-")),
    [],
  );
  // And by uninstall: the last one to go takes Ghidra with it.
  await rea.apply({ components: { ghidra: true } });
  await rea.settled();
  await craft.apply({ components: { ghidra: true } });
  await craft.settled();
  await rea.uninstall();
  assert.ok(present(f));
  await craft.uninstall();
  assert.equal(fs.existsSync(linkOf(f, "rea-ghidra")), false);
  assert.equal(fs.existsSync(linkOf(f, "rea-jdk")), false);
});

test("REA's dialog state says shared when Craft Anything uses Ghidra", async (t) => {
  const { rea, craft, installBoth } = await pair(t);
  assert.equal(rea.state().components.ghidra.shared, false);
  await installBoth();
  assert.equal(rea.state().components.ghidra.shared, true);
  assert.equal(craft.state().components.ghidra.shared, true);
  await craft.apply({ components: { ghidra: false } });
  await craft.settled();
  assert.equal(rea.state().components.ghidra.shared, false);
  assert.equal(craft.state().components.ghidra.shared, true);
});

test("an update does not replace Ghidra while the other tool's session uses it", async (t) => {
  for (const [updater, user] of [
    ["rea", "craft"],
    ["craft", "rea"],
  ]) {
    const old = await pair(t, { pins: { ghidra: "12.1.3", jdk: "21.0.12+7" } });
    await old.installBoth();
    await old.rea.close();
    await old.craft.close();
    const { f } = old;
    // A newer AgentPier pins newer Ghidra and JDK; the other tool's session runs.
    const busy = { rea: false, craft: false };
    const tools = { rea: await f.reaTool(), craft: await f.tool() };
    for (const [one, other] of [
      ["rea", "craft"],
      ["craft", "rea"],
    ]) {
      tools[one].inUse = async () => busy[one];
      tools[one].keepsGhidra = () => tools[other].wantsGhidra();
      tools[one].othersUseGhidra = async () =>
        (await tools[other].inUse()) && tools[other].wantsGhidra();
    }
    const tool = tools[updater];
    const before = tool.component("rea-ghidra").directory;
    assert.equal(tool.state().components.ghidra.outdated, true);
    busy[user] = true;
    await tool.update();
    await tool.settled();
    assert.equal(tool.state().status, "succeeded", `${updater}: ${tool.state().message}`);
    assert.equal(tool.component("rea-ghidra").version, "12.1.3");
    assert.equal(tool.component("rea-jdk").version, "21.0.12+7");
    assert.equal(tool.component("rea-ghidra").directory, before);
    assert.equal(fs.existsSync(before), true);
    assert.equal(tool.state().components.ghidra.outdated, true);
    assert.equal(tool.state().updateAvailable, true);
    // The session ended: the next update replaces it.
    busy[user] = false;
    await tool.update();
    await tool.settled();
    assert.equal(tool.state().status, "succeeded", tool.state().message);
    assert.equal(tool.component("rea-ghidra").version, "12.1.4");
    assert.equal(tool.component("rea-jdk").version, "21.0.13+9");
    assert.equal(tool.state().components.ghidra.outdated, false);
  }
});

test("a missing Ghidra is installed even while the other tool's session runs", async (t) => {
  const { f, rea, craft, busy } = await pair(t);
  const state = await f.reaInstall(rea, { components: { ghidra: false, frida: false } });
  assert.equal(state.status, "succeeded", state.message);
  busy.rea = true;
  rea.wantsGhidra = () => true;
  assert.equal(
    (await f.install(craft, { components: { ghidra: true } })).status,
    "succeeded",
  );
  assert.ok(present(f));
});

test("a job is refused while the other tool's job runs", async (t) => {
  const { f, rea, craft } = await pair(t);
  await rea.apply({ components: { ghidra: true, frida: false }, confirmInstall: true });
  assert.ok(rea.job);
  const craftBusy = refused(serverMessages.craft.busy);
  await assert.rejects(
    craft.apply({ components: { ghidra: true }, confirmInstall: true }),
    craftBusy,
  );
  await assert.rejects(craft.uninstall(), craftBusy);
  await rea.settled();
  assert.equal(rea.state().status, "succeeded", rea.state().message);
  await craft.apply({ components: { ghidra: true }, confirmInstall: true });
  assert.ok(craft.job);
  const reaBusy = refused(serverMessages.rea.busy);
  await assert.rejects(rea.apply({ components: { ghidra: false } }), reaBusy);
  await assert.rejects(rea.update(), reaBusy);
  await assert.rejects(rea.uninstall(), reaBusy);
  await craft.settled();
  assert.equal(craft.state().status, "succeeded", craft.state().message);
  // A claimed slot (a refusal check awaiting inUse) counts as busy too.
  craft.claimed = true;
  await assert.rejects(rea.update(), reaBusy);
  craft.claimed = false;
  await rea.update();
  await rea.settled();
  assert.equal(rea.state().status, "succeeded", rea.state().message);
  assert.ok(present(f));
});

test("a start sweep spares the other tool's install in progress", async (t) => {
  const { f, rea, craft } = await pair(t);
  const leftovers = () => {
    const work = path.join(f.root, ".rea-install-other");
    const unpublished = path.join(f.root, ".packages", "craft-anything-0.5.0-pending");
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(unpublished, { recursive: true });
    return [work, unpublished];
  };
  // Craft Anything's job runs: REA's start leaves its folders alone.
  craft.claimed = true;
  let kept = leftovers();
  await rea.start();
  assert.ok(kept.every((p) => fs.existsSync(p)));
  craft.claimed = false;
  // REA's job runs: Craft Anything's start leaves them alone too.
  rea.claimed = true;
  kept = leftovers();
  await craft.start();
  assert.ok(kept.every((p) => fs.existsSync(p)));
  rea.claimed = false;
  // Nobody busy: the sweep removes them.
  await craft.start();
  assert.ok(kept.every((p) => !fs.existsSync(p)));
});
