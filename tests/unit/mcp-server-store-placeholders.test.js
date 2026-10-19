import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { cliSupport } from "../../server/features/mcp-servers/cli-native.js";

const dataDirs = [];
after(() => dataDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function store() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-placeholders-"));
  dataDirs.push(dataDir);
  return new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    exists: (file) => file === "/fake/bin/uvx",
  });
}
const voice = (extra = {}) => ({
  name: "voice",
  transport: "stdio",
  command: "uvx",
  args: ["elevenlabs-mcp", "--out={agent.workspace}/voice"],
  cwd: "{agent.workspace}",
  env: {
    ELEVENLABS_MCP_BASE_PATH: "{agent.attachments}",
    ELEVENLABS_API_KEY: "sk-secret",
  },
  ...extra,
});
const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return { code: error.code, field: error.field, names: error.names };
  }
  return null;
};

test("a stdio server stores agent placeholders and shows where it uses them", () => {
  const s = store();
  const server = s.create(voice());
  assert.equal(server.cwd, "{agent.workspace}");
  assert.equal(server.agentPlaceholders, true);
  assert.deepEqual(server.placeholders, {
    args: [{ index: 1, template: "--out={agent.workspace}/voice" }],
    cwd: "{agent.workspace}",
    env: { ELEVENLABS_MCP_BASE_PATH: "{agent.attachments}" },
  });
  // Other environment values stay write-only.
  assert.doesNotMatch(JSON.stringify(s.list()), /sk-secret/);
  assert.equal(s.definitions()[0].agentPlaceholders, true);
  // A server without placeholders keeps its earlier shape.
  const plain = s.create(voice({ name: "plain", args: [], cwd: null, env: { A: "1" } }));
  assert.equal("agentPlaceholders" in plain, false);
  assert.equal("agentPlaceholders" in s.definitions()[0], false);
});

test("invalid or misplaced placeholders are refused by field and name", () => {
  const s = store();
  assert.deepEqual(
    codeOf(() => s.create(voice({ env: { BASE: "{agent.workspace}/../x" } }))),
    { code: "MCP_SERVER_PLACEHOLDER", field: "env", names: ["BASE"] },
  );
  assert.equal(codeOf(() => s.create(voice({ cwd: "{session.cwd}" }))).field, "cwd");
  assert.equal(codeOf(() => s.create(voice({ args: ["{agent.home}"] }))).field, "args");
  assert.deepEqual(
    codeOf(() =>
      s.create({
        name: "docs",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { "X-Dir": "{agent.workspace}" },
      }),
    ),
    { code: "MCP_SERVER_PLACEHOLDER", field: "headers", names: ["X-Dir"] },
  );
  const saved = s.create(voice({ name: "ok" }));
  assert.equal(
    codeOf(() => s.update(saved.id, { revision: 1, args: ["{agent.workspace}/./x"] }))
      .field,
    "args",
  );
});

test("an update preview tells whether placeholders remain after set and drop", () => {
  const s = store();
  const saved = s.create(voice({ args: [], cwd: null }));
  assert.equal(s.previewUpdate(saved.id, { revision: 1 }).after.agentPlaceholders, true);
  const dropped = s.previewUpdate(saved.id, {
    revision: 1,
    env: { ELEVENLABS_MCP_BASE_PATH: null },
  });
  assert.equal(dropped.after.agentPlaceholders, undefined);
  const replaced = s.previewUpdate(saved.id, {
    revision: 1,
    env: { ELEVENLABS_MCP_BASE_PATH: "/tmp/shared" },
  });
  assert.equal(replaced.after.agentPlaceholders, undefined);
});

test("no coding CLI runs a server with agent placeholders", () => {
  const s = store();
  const server = s.create(voice());
  for (const cli of ["claude", "codex", "opencode"]) {
    assert.deepEqual(cliSupport(cli, server), {
      supported: false,
      reason: "placeholder",
    });
    assert.deepEqual(cliSupport(cli, s.definitions()[0]), {
      supported: false,
      reason: "placeholder",
    });
  }
  // A raw input (create with CLIs) is judged by its own values.
  assert.equal(cliSupport("codex", voice({ args: [], cwd: null })).reason, "placeholder");
  assert.equal(
    cliSupport("codex", voice({ args: [], cwd: null, env: { A: "x" } })).supported,
    true,
  );
});
