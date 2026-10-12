import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliMcpFixture, http, stdio } from "../helpers/cli-mcp.js";

/**
 * `after` is `before` with one contiguous run of lines inserted: every byte of
 * `before` survives in place. Returns the inserted lines.
 */
function inserted(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
    tail++;
  assert.equal(head + tail, a.length, "an owner line changed");
  return b.slice(head, b.length - tail).join("\n");
}

const codexOwner = `# Keep this top comment
model = "fixture" # model comment
since = 1979-05-27T07:32:00Z

[mcp_servers.owner] # owner header comment
# owner comment inside the entry
command = "/bin/owner"
startup_timeout_sec = 60.0
args = [ "-v",   "--x" ]

[mcp_servers.owner.env]
KEY = 'literal'

[projects."/space path"]
trust_level = "trusted"
when = 2024-01-02
`;

test("codex: binding, rotating and unbinding leave every owner byte in place", (t) => {
  const f = cliMcpFixture(t);
  f.raw("codex", codexOwner);
  const server = f.servers.create(http(), { bind: [["cli", "codex"]] });
  f.reconciler.reconcile("codex");
  const bound = f.text("codex");
  assert.match(inserted(codexOwner, bound), /^\[mcp_servers\.docs\]/m);
  assert.ok(bound.startsWith(codexOwner));
  // An owner table after AgentPier's: a rotation edits AgentPier's table in place.
  const tail = "\n[profile]\nratio = 1.50\n";
  f.raw("codex", bound + tail);
  f.servers.update(server.id, {
    revision: 1,
    headers: { Authorization: "Bearer rotated-secret" },
  });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
  const rotated = f.text("codex");
  assert.ok(rotated.startsWith(codexOwner) && rotated.endsWith(tail));
  assert.match(rotated, /rotated-secret/);
  f.servers.setClis(server.id, []);
  f.reconciler.reconcile("codex");
  assert.equal(f.text("codex"), codexOwner + tail);
});

const openCodeOwner = `{
  // owner comment
  "theme": "keep-me",
  "mcp": {
    /* owner block comment */
    "owner": { "type": "local", "command": ["/bin/owner"], "enabled": true, }, // trailing
  },
}
`;

test("opencode: comments and trailing commas around the owner's entry stay", (t) => {
  const f = cliMcpFixture(t);
  f.raw("opencode", openCodeOwner);
  const server = f.servers.create(stdio(), { bind: [["cli", "opencode"]] });
  f.reconciler.reconcile("opencode");
  const bound = f.text("opencode");
  assert.match(inserted(openCodeOwner, bound), /^ {4}"local": \{/);
  f.servers.update(server.id, { revision: 1, env: { TOKEN: "rotated-secret" } });
  assert.deepEqual(f.reconciler.reconcile("opencode").statuses[server.id], {
    status: "written",
  });
  assert.match(inserted(openCodeOwner, f.text("opencode")), /rotated-secret/);
  f.servers.setClis(server.id, []);
  f.reconciler.reconcile("opencode");
  assert.equal(f.text("opencode"), openCodeOwner);
});

test("claude: unrelated keys keep their values and order", (t) => {
  const f = cliMcpFixture(t);
  const owner = {
    numStartups: 3,
    mcpServers: { mine: { type: "stdio", command: "/bin/owner", args: [], env: {} } },
    projects: { "/fixture": { trusted: true } },
    theme: "keep-me",
  };
  const original = `${JSON.stringify(owner, null, 2)}\n`;
  f.raw("claude", original);
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  f.reconciler.reconcile("claude");
  f.servers.update(server.id, {
    revision: 1,
    headers: { Authorization: "Bearer rotated-secret" },
  });
  f.reconciler.reconcile("claude");
  const data = JSON.parse(f.text("claude"));
  assert.deepEqual(Object.keys(data), Object.keys(owner));
  assert.deepEqual(Object.keys(data.mcpServers), ["mine", "docs"]);
  assert.deepEqual({ ...data, mcpServers: { mine: data.mcpServers.mine } }, owner);
  f.servers.setClis(server.id, []);
  f.reconciler.reconcile("claude");
  assert.equal(f.text("claude"), original);
});

// Review Focus 3, for an environment value in Codex.
test("codex: a new environment value rewrites AgentPier's entry and is no conflict", (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(stdio(), { bind: [["cli", "codex"]] });
  f.reconciler.reconcile("codex");
  f.servers.update(server.id, { revision: 1, env: { TOKEN: "rotated-secret" } });
  assert.deepEqual(f.reconciler.reconcile("codex").statuses[server.id], {
    status: "written",
  });
  assert.equal(f.entries("codex").local.env.TOKEN, "rotated-secret");
});

test("an MCP table Codex cannot edit in place is refused as layout, untouched", (t) => {
  const f = cliMcpFixture(t);
  const text = 'mcp_servers = { owner = { command = "/bin/owner" } }\n';
  f.raw("codex", text);
  const server = f.servers.create(http(), { bind: [["cli", "codex"]] });
  const result = f.reconciler.reconcile("codex");
  assert.equal(result.error, "layout");
  assert.deepEqual(result.statuses[server.id], { status: "error", reason: "layout" });
  assert.equal(f.text("codex"), text);
  assert.deepEqual(f.warnings, [
    "MCP servers for codex could not be written (layout: CLI_CONFIG_LAYOUT).",
  ]);
});

test("a configuration directory that cannot be written reports write-failed", (t) => {
  const f = cliMcpFixture(t);
  f.write("codex", {});
  const dir = path.dirname(f.file("codex"));
  const server = f.servers.create(http(), { bind: [["cli", "codex"]] });
  fs.chmodSync(dir, 0o500);
  let result;
  try {
    result = f.reconciler.reconcile("codex");
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.equal(result.error, "write-failed");
  assert.deepEqual(result.statuses[server.id], {
    status: "error",
    reason: "write-failed",
  });
  assert.deepEqual(f.warnings, [
    "MCP servers for codex could not be written (write-failed: EACCES).",
  ]);
});

test("a definition that cannot be projected marks only its own server", (t) => {
  const f = cliMcpFixture(t);
  const bad = f.servers.create(stdio(), { bind: [["cli", "opencode"]] });
  const good = f.servers.create(http(), { bind: [["cli", "opencode"]] });
  const definitions = f.servers.definitions.bind(f.servers);
  f.servers.definitions = () =>
    definitions().map((item) => (item.id === bad.id ? { ...item, args: 5 } : item));
  const result = f.reconciler.reconcile("opencode");
  assert.equal(result.error, undefined);
  assert.deepEqual(result.statuses[bad.id], { status: "error", reason: "invalid" });
  assert.deepEqual(result.statuses[good.id], { status: "written" });
  assert.deepEqual(Object.keys(f.entries("opencode")), ["docs"]);
});

test("a store error is thrown, not reported as a file problem", (t) => {
  const f = cliMcpFixture(t);
  f.servers.create(http(), { bind: [["cli", "claude"]] });
  f.servers.cliEntries.intend = () => {
    throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" });
  };
  assert.throws(() => f.reconciler.reconcile("claude"), { code: "ERR_SQLITE_ERROR" });
  assert.equal(fs.existsSync(f.file("claude")), false);
  assert.deepEqual(f.warnings, []);
});
