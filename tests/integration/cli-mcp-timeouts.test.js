import test from "node:test";
import assert from "node:assert/strict";
import {
  adoptFinds,
  patchFromNative,
} from "../../server/features/mcp-servers/cli-adoption.js";
import { groupFinds, publicFind } from "../../server/features/mcp-servers/cli-finds.js";
import { centralFromNative, clis } from "../../server/features/mcp-servers/cli-native.js";
import { cliMcpFixture, stdio } from "../helpers/cli-mcp.js";

const groups = (f) =>
  groupFinds(
    Object.fromEntries(clis.map((cli) => [cli, f.reconciler.inspect(cli)])),
    f.servers.list().map((server) => server.name),
  );
const adopt = (f, options) =>
  adoptFinds({
    servers: f.servers,
    reconciler: f.reconciler,
    groups: groups(f),
    ...options,
  });
// What `rea setup` writes into ~/.codex/config.toml.
const reaEntry = {
  command: "/fake/bin/rea",
  args: ["mcp"],
  env: {},
  startup_timeout_sec: 30,
  tool_timeout_sec: 450,
};
const written = { status: "written" };

test("a Codex entry with timeouts is adopted with its values and stays as written", (t) => {
  const f = cliMcpFixture(t);
  f.write("codex", { rea: reaEntry });
  const [find] = groups(f).map(publicFind);
  assert.equal(find.adoptable, true);
  assert.deepEqual([find.startupTimeoutSec, find.toolTimeoutSec], [30, 450]);
  const { adopted, failed } = adopt(f, { keys: [find.key] });
  assert.deepEqual(failed, []);
  const server = f.servers.get(adopted[0].id);
  assert.deepEqual([server.startupTimeoutSec, server.toolTimeoutSec], [30, 450]);
  assert.deepEqual(f.entries("codex").rea, reaEntry);
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], written);
  // Bound to Claude Code and OpenCode, the server takes its tool timeout along.
  f.servers.setClis(server.id, ["codex", "claude", "opencode"]);
  for (const cli of clis)
    assert.deepEqual(f.reconciler.reconcile(cli).statuses[server.id], written, cli);
  assert.equal(f.entries("claude").rea.timeout, 450000);
  assert.equal(f.entries("opencode").rea.timeout, 450000);
  assert.equal(f.entries("claude").rea.startup_timeout_sec, undefined);
});

test("a timeout AgentPier cannot hold keeps the entry unmanaged and untouched", (t) => {
  const f = cliMcpFixture(t);
  const slow = { url: "https://x.example.test/mcp", startup_timeout_sec: 2.5 };
  f.write("codex", { slow });
  const [find] = groups(f).map(publicFind);
  assert.deepEqual([find.adoptable, find.reason], [false, "unsupported-fields"]);
  assert.throws(() => adopt(f, { keys: [find.key] }), { status: 409 });
  assert.deepEqual(adopt(f, { all: true }), { adopted: [], failed: [] });
  assert.deepEqual(f.entries("codex").slow, slow);
  assert.deepEqual(f.servers.list(), []);
});

test("a record round-trips through Codex TOML and reads back with its timeouts", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(stdio({ startupTimeoutSec: 30, toolTimeoutSec: 450 }), {
    bind: [["cli", "codex"]],
  });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], written);
  const text = f.text("codex");
  assert.match(text, /^startup_timeout_sec = 30$/m);
  assert.match(text, /^tool_timeout_sec = 450$/m);
  const parsed = centralFromNative("codex", f.entries("codex").local);
  assert.deepEqual(
    [parsed.definition.startupTimeoutSec, parsed.definition.toolTimeoutSec],
    [30, 450],
  );
  // A changed timeout rewrites AgentPier's entry; clearing one removes its key.
  f.servers.update(server.id, { revision: 1, toolTimeoutSec: 900 });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], written);
  assert.equal(f.entries("codex").local.tool_timeout_sec, 900);
  f.servers.update(server.id, { revision: 2, startupTimeoutSec: null });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], written);
  assert.equal(Object.hasOwn(f.entries("codex").local, "startup_timeout_sec"), false);
});

test("adopting a hand edit takes the timeouts that CLI can express", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(stdio({ startupTimeoutSec: 30, toolTimeoutSec: 450 }), {
    bind: [
      ["cli", "codex"],
      ["cli", "claude"],
    ],
  });
  f.reconciler.reconcile("codex");
  f.reconciler.reconcile("claude");
  const codex = f.entries("codex").local;
  f.write("codex", { local: { ...codex, tool_timeout_sec: 900 } });
  let found = f.reconciler.contested(server.id, "codex");
  assert.deepEqual(
    patchFromNative(
      f.servers.get(server.id),
      "codex",
      centralFromNative("codex", found.entry),
    ),
    {
      revision: 1,
      command: "/fake/bin/server",
      args: ["--port", "1"],
      cwd: "",
      env: { TOKEN: "env-secret" },
      toolTimeoutSec: 900,
    },
  );
  // Claude Code has no startup timeout: dropping its `timeout` clears the tool one only.
  const { timeout: _timeout, ...claude } = f.entries("claude").local;
  f.write("claude", { local: claude });
  found = f.reconciler.contested(server.id, "claude");
  const patch = patchFromNative(
    f.servers.get(server.id),
    "claude",
    centralFromNative("claude", found.entry),
  );
  assert.equal(patch.toolTimeoutSec, null);
  assert.equal(Object.hasOwn(patch, "startupTimeoutSec"), false);
  const updated = f.servers.update(server.id, patch);
  assert.deepEqual([updated.startupTimeoutSec, updated.toolTimeoutSec], [30, undefined]);
});
