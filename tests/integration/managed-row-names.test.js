import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliTrouble } from "../../server/features/mcp-servers/cli-status.js";
import {
  documents,
  profileLocation,
  readShared,
} from "../../server/features/cli-profiles/configuration.js";
import { fingerprint } from "../../server/features/cli-profiles/synchronization.js";
import { writePrivate } from "../../server/lib/storage.js";
import { cliMcpFixture } from "../helpers/cli-mcp.js";
import { craftFixture } from "../helpers/craft-tool-fixture.js";
import { reaFixture } from "../helpers/rea-tool-fixture.js";

// An entry the owner (or another AgentPier instance) wrote into Claude Code by hand.
const native = (command) => ({ type: "stdio", command, args: ["mcp"], env: {} });
// The card's binding error, as services wires it (craft-wiring.js).
const hook = (tool, s) => {
  tool.cliTrouble = (id) =>
    cliTrouble({ servers: s.servers, inspect: (cli) => s.reconciler.inspect(cli) }, id);
  return tool;
};
// A managed Claude Code account's own .claude.json.
const managedClaude = (s, name = "Claude test") => {
  const account = s.accounts.create({ name, tool: "claude" });
  const location = profileLocation(s.accounts, account.id);
  return { account, location, file: documents(location)[0].file };
};
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
};

test("REA takes rea-agentpier when Claude Code already has an entry named rea", async (t) => {
  const f = await reaFixture(t);
  f.s.write("claude", { rea: native("/fake/other/rea") });
  const rea = hook(await f.tool(), f.s);
  const state = await f.install(rea, { components: { ghidra: false, frida: false } });
  assert.equal(state.status, "succeeded", state.message);
  assert.equal(state.serverName, "rea-agentpier");
  const entries = f.s.entries("claude");
  assert.deepEqual(entries.rea, native("/fake/other/rea"));
  assert.ok(entries["rea-agentpier"]);
  assert.equal(state.binding, null);
  assert.equal(rea.utility().binding, null);
});

test("REA skips the names a managed Claude Code profile holds as well", async (t) => {
  const f = await reaFixture(t);
  f.s.write("claude", { rea: native("/fake/other/rea") });
  const { file } = managedClaude(f.s);
  writeJson(file, { mcpServers: { "REA-AgentPier": native("/fake/third/rea") } });
  const rea = await f.tool();
  const state = await f.install(rea, { components: { ghidra: false, frida: false } });
  assert.equal(state.serverName, "rea-agentpier-2");
});

test("Craft Anything takes craft-anything-agentpier next to a native entry", async (t) => {
  const f = await craftFixture(t);
  f.s.write("claude", { "craft-anything": native("/fake/other/craft") });
  const craft = hook(await f.tool(), f.s);
  const state = await f.install(craft, { components: { ghidra: false } });
  assert.equal(state.status, "succeeded", state.message);
  assert.equal(state.serverName, "craft-anything-agentpier");
  assert.deepEqual(f.s.entries("claude")["craft-anything"], native("/fake/other/craft"));
  assert.equal(state.binding, null);
});

test("the REA card reports a Claude Code binding that is not in effect", async (t) => {
  const f = await reaFixture(t);
  const rea = hook(await f.tool(), f.s);
  const state = await f.install(rea, { components: { ghidra: false, frida: false } });
  assert.equal(state.binding, null);
  // The owner edits AgentPier's entry by hand: it is no longer AgentPier's to write.
  const entries = f.s.entries("claude");
  f.s.write("claude", { ...entries, rea: { ...entries.rea, args: ["edited"] } });
  const expected = {
    cli: "claude",
    status: "conflict",
    messageKey: "mcpServers.cliStatusConflict",
  };
  assert.deepEqual(rea.state().binding, expected);
  assert.deepEqual(rea.utility().binding, expected);
});

// A second AgentPier data directory (the live instance beside a test instance).
const otherInstance = (s) => {
  const dir = path.join(s.root, "other-agentpier");
  fs.mkdirSync(path.join(dir, "mcp-servers"), { recursive: true });
  fs.writeFileSync(path.join(dir, "accounts.json"), "[]");
  fs.writeFileSync(path.join(dir, "mcp-servers", "servers.sqlite"), "");
  return dir;
};

test("shared-profile sync keeps another AgentPier instance's entries out of managed profiles", async (t) => {
  const s = cliMcpFixture(t);
  const other = otherInstance(s);
  const foreign = {
    type: "stdio",
    command: "/usr/bin/env",
    args: ["node", "proxy.js"],
    env: { HOME: path.join(other, "rea", "home") },
  };
  const own = { ...foreign, env: { HOME: path.join(s.dataDir, "rea", "home") } };
  const plain = native("/fake/bin/docs");
  s.write("claude", { rea: foreign, mine: own, docs: plain });
  const canonical = s.text("claude");
  const { account, file } = managedClaude(s);
  s.sharedProfiles.prepare(account, {});
  const managed = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers;
  assert.deepEqual(Object.keys(managed).sort(), ["docs", "mine"]);
  // The owner's own home profile keeps every entry.
  assert.equal(s.text("claude"), canonical);
  // A foreign entry added in the managed profile is never imported, and the next start
  // neither removes the canonical one nor brings it back.
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.mcpServers["craft-anything"] = { ...foreign, command: path.join(other, "craft") };
  writeJson(file, data);
  s.sharedProfiles.prepare(account, {});
  assert.equal(s.text("claude"), canonical);
  assert.deepEqual(
    Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers).sort(),
    ["docs", "mine"],
  );
});

test("an entry another instance put in a managed profile earlier never leaves the home profile", async (t) => {
  const s = cliMcpFixture(t);
  const other = otherInstance(s);
  const foreign = native(path.join(other, "mcp-packages", "bin", "rea"));
  const { account, location, file } = managedClaude(s);
  // An older AgentPier projected the foreign entry: both profiles and the baseline
  // hold it, as its prepare left them.
  s.write("claude", { rea: foreign });
  writeJson(file, { mcpServers: { rea: foreign } });
  s.sharedProfiles.migrate(account.id);
  const state = JSON.parse(fs.readFileSync(s.sharedProfiles.file, "utf8"));
  state[account.id].profiles[location.root].baseline = fingerprint(readShared(location));
  writePrivate(s.sharedProfiles.file, state);
  s.sharedProfiles.prepare(account, {});
  assert.deepEqual(s.entries("claude"), { rea: foreign });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers, {});
  s.sharedProfiles.prepare(account, {});
  assert.deepEqual(s.entries("claude"), { rea: foreign });
});
