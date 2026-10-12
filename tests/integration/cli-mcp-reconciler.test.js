import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  cliEntry,
  clis,
  entryHash,
} from "../../server/features/mcp-servers/cli-native.js";
import { cliMcpFixture, http, stdio } from "../helpers/cli-mcp.js";

const unrelated = {
  claude:
    '{\n  "theme": "keep-me",\n  "projects": { "/fixture": { "trusted": true } }\n}\n',
  codex:
    '# Keep this exact comment\nmodel = "fixture" # model comment\n[projects."/space path"]\ntrust_level = "trusted"\n',
  opencode: '{\n  // keep this comment\n  "theme": "keep-me",\n}\n',
};
const definition = (f, id) => f.servers.definitions().find((item) => item.id === id);

for (const cli of clis)
  test(`${cli}: a binding writes AgentPier's entry, keeps the rest and records only a hash`, (t) => {
    const f = cliMcpFixture(t);
    f.raw(cli, unrelated[cli]);
    const server = f.servers.create(http(), { bind: [["cli", cli]] });
    const result = f.reconciler.reconcile(cli);
    assert.deepEqual(result.statuses[server.id], { status: "written" });
    const expected = cliEntry(
      cli,
      definition(f, server.id),
      f.servers.secrets(server.id),
    );
    assert.deepEqual(f.entries(cli).docs, expected);
    if (cli === "codex") assert.ok(f.text(cli).startsWith(unrelated.codex));
    else
      assert.match(
        f.text(cli),
        cli === "claude" ? /"theme": "keep-me"/ : /\/\/ keep this comment/,
      );
    assert.equal(fs.statSync(f.file(cli)).mode & 0o777, 0o600);
    const row = f.servers.cliEntries.get(server.id, cli);
    assert.deepEqual(
      [row.name, row.hash, row.pendingHash],
      ["docs", entryHash(expected), null],
    );
    assert.doesNotMatch(JSON.stringify([row, result.statuses, f.warnings]), /secret/);
    assert.deepEqual(result.finds, []);
  });

test("unbinding or deleting removes only AgentPier's entry and its record", (t) => {
  const f = cliMcpFixture(t);
  f.write("claude", { mine: { type: "stdio", command: "/bin/owner" } });
  const a = f.servers.create(http(), { bind: [["cli", "claude"]] });
  const b = f.servers.create(http({ name: "other" }), { bind: [["cli", "claude"]] });
  f.reconciler.reconcile("claude");
  assert.deepEqual(Object.keys(f.entries("claude")).sort(), ["docs", "mine", "other"]);
  f.servers.setClis(a.id, []);
  f.servers.remove(b.id);
  const result = f.reconciler.reconcile("claude");
  assert.deepEqual(f.entries("claude"), {
    mine: { type: "stdio", command: "/bin/owner" },
  });
  assert.deepEqual(f.servers.cliEntries.list("claude"), []);
  assert.deepEqual(
    result.finds.map((find) => find.name),
    ["mine"],
  );
});

test("a hand-edited entry is a conflict until the owner chooses, and a find once unbound", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "codex"]] });
  f.reconciler.reconcile("codex");
  const edited = { ...f.entries("codex").docs, url: "https://edited.example.test/mcp" };
  f.write("codex", { docs: edited });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "conflict",
  });
  assert.deepEqual(f.entries("codex").docs, edited);
  f.reconciler.overwrite(server.id, "codex");
  assert.equal(
    f.entries("codex").docs.url,
    "https://mcp.example.test/mcp?key=query-secret",
  );
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
  f.write("codex", { docs: edited });
  f.servers.setClis(server.id, []);
  const result = f.reconciler.reconcile("codex");
  assert.deepEqual(f.entries("codex").docs, edited);
  assert.deepEqual(
    result.finds.map((find) => find.name),
    ["docs"],
  );
  assert.throws(() => f.reconciler.overwrite(server.id, "codex"), { status: 409 });
});

test("a name taken by the owner's entry is neither written nor listed as a find", (t) => {
  const f = cliMcpFixture(t);
  const owner = { type: "remote", url: "https://owner.example.test/mcp", enabled: true };
  f.write("opencode", { docs: owner });
  const server = f.servers.create(http(), { bind: [["cli", "opencode"]] });
  const result = f.reconciler.reconcile("opencode");
  assert.deepEqual(result.statuses[server.id], { status: "name-taken" });
  assert.deepEqual(f.entries("opencode"), { docs: owner });
  assert.deepEqual(result.finds, []);
  assert.equal(f.servers.cliEntries.get(server.id, "opencode"), null);
});

test("a configuration that cannot be read is never written; the other CLIs continue", (t) => {
  const f = cliMcpFixture(t);
  const broken = {
    claude: '{/* Claude accepts no comments */"theme":"keep"}',
    codex: "invalid = [",
    opencode: '{"mcp":{"old":{"type":"local","command":["keep"]}},"mcp":{}}',
  };
  const server = f.servers.create(http(), { bind: clis.map((cli) => ["cli", cli]) });
  for (const [cli, text] of Object.entries(broken)) {
    for (const other of clis) fs.rmSync(f.file(other), { force: true });
    f.raw(cli, text);
    const result = f.reconciler.reconcile(cli);
    assert.equal(result.error, "unreadable");
    assert.deepEqual(result.statuses[server.id], {
      status: "error",
      reason: "unreadable",
    });
    assert.equal(f.text(cli), text);
    const fine = clis.find((other) => other !== cli);
    assert.deepEqual(f.reconciler.reconcile(fine).statuses[server.id], {
      status: "written",
    });
  }
  assert.ok(f.warnings.length > 0);
  assert.ok(f.warnings.every((line) => !line.includes(f.home) && !/secret/.test(line)));
});

test("a symlinked configuration file is refused and its target untouched", (t) => {
  const f = cliMcpFixture(t);
  const outside = path.join(f.root, "outside.json");
  fs.writeFileSync(outside, "{}");
  fs.symlinkSync(outside, f.file("claude"));
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[server.id], {
    status: "error",
    reason: "unreadable",
  });
  assert.equal(fs.readFileSync(outside, "utf8"), "{}");
});

test("an OpenCode name defined in two files is left alone", (t) => {
  const f = cliMcpFixture(t);
  const dir = path.join(f.home, ".config/opencode");
  fs.mkdirSync(dir, { recursive: true });
  const one = JSON.stringify({ mcp: { docs: { type: "local", command: ["old"] } } });
  const two = JSON.stringify({ mcp: { docs: { type: "local", command: ["new"] } } });
  fs.writeFileSync(path.join(dir, "opencode.json"), one);
  fs.writeFileSync(path.join(dir, "opencode.jsonc"), two);
  const server = f.servers.create(http(), { bind: [["cli", "opencode"]] });
  const result = f.reconciler.reconcile("opencode");
  assert.deepEqual(result.statuses[server.id], { status: "error", reason: "duplicate" });
  assert.equal(fs.readFileSync(path.join(dir, "opencode.json"), "utf8"), one);
  assert.equal(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8"), two);
});

test("inspect reports without writing anything", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(stdio(), { bind: [["cli", "claude"]] });
  assert.deepEqual(f.reconciler.inspect("claude").statuses[server.id], {
    status: "pending",
  });
  assert.equal(fs.existsSync(f.file("claude")), false);
  assert.deepEqual(f.servers.cliEntries.list("claude"), []);
});

test("a server the CLI cannot run is reported and its old entry removed", (t) => {
  const f = cliMcpFixture(t);
  const sse = f.servers.create(http({ name: "events", transport: "sse" }), {
    bind: [["cli", "codex"]],
  });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[sse.id], {
    status: "error",
    reason: "transport",
  });
  assert.deepEqual(f.entries("codex"), {});
  const local = f.servers.create(stdio(), { bind: [["cli", "claude"]] });
  f.reconciler.reconcile("claude");
  assert.ok(f.entries("claude").local);
  f.servers.update(local.id, { revision: 1, cwd: "/tmp" });
  assert.deepEqual(f.reconciler.reconcile("claude").statuses[local.id], {
    status: "error",
    reason: "cwd",
  });
  assert.equal(f.entries("claude").local, undefined);
});
