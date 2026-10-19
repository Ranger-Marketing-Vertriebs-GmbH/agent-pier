import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fc from "fast-check";
import {
  PLACEHOLDER,
  agentFolders,
  hasPlaceholderCandidate,
  parsePlaceholder,
  placeholderTemplates,
  requireValidPlaceholders,
  resolvePlaceholder,
  resolveStdioServer,
  usesAgentPlaceholders,
} from "../../server/features/mcp-servers/agent-placeholders.js";

const root = "/data/assistants/workspaces";
const folders = agentFolders(root, "a1");

test("a candidate is any {agent.…} or {session.…}, nothing else", () => {
  assert.equal(hasPlaceholderCandidate("{agent.workspace}"), true);
  assert.equal(hasPlaceholderCandidate("x {Agent.Nope} y"), true);
  assert.equal(hasPlaceholderCandidate("{session.cwd}"), true);
  assert.equal(hasPlaceholderCandidate('{"a.b": 1}'), false);
  assert.equal(hasPlaceholderCandidate("{record.message}"), false);
  assert.equal(hasPlaceholderCandidate(42), false);
});

test("the fixed placeholders parse as whole values or with a subfolder", () => {
  assert.deepEqual(parsePlaceholder("{agent.workspace}"), {
    prefix: "",
    name: "agent.workspace",
    segments: [],
  });
  assert.deepEqual(parsePlaceholder("{agent.attachments}/voice/out/"), {
    prefix: "",
    name: "agent.attachments",
    segments: ["voice", "out"],
  });
  assert.deepEqual(parsePlaceholder("--dir={agent.workspace}/x", { prefix: true }), {
    prefix: "--dir=",
    name: "agent.workspace",
    segments: ["x"],
  });
  assert.equal(parsePlaceholder("plain"), null);
});

test("anything else in the namespace is refused, never passed on literally", () => {
  for (const value of [
    "{agent.workspce}",
    "{session.cwd}",
    "{agent.workspace}/../other",
    "{agent.workspace}/./x",
    "{agent.workspace}//x",
    "{agent.workspace}x",
    "{agent.workspace}/a\u0001b",
    "{agent.workspace}/{agent.attachments}",
    "{agent.workspace}{agent.workspace}",
    "--dir={agent.workspace}",
    "{ agent.workspace }",
    "{agent.workspace}/a}b",
  ])
    assert.equal(parsePlaceholder(value), false, value);
  // A prefix is allowed for arguments only, and never with braces.
  assert.equal(parsePlaceholder("{x}--d={agent.workspace}", { prefix: true }), false);
});

test("resolution joins the agent's own folder and the subfolder", () => {
  assert.deepEqual(folders, {
    "agent.workspace": "/data/assistants/workspaces/a1",
    "agent.attachments": "/data/assistants/workspaces/a1/attachments",
  });
  assert.deepEqual(resolvePlaceholder("{agent.workspace}/voice", folders), {
    value: "/data/assistants/workspaces/a1/voice",
    path: "/data/assistants/workspaces/a1/voice",
  });
  assert.deepEqual(resolvePlaceholder("--out={agent.attachments}", folders, true), {
    value: "--out=/data/assistants/workspaces/a1/attachments",
    path: "/data/assistants/workspaces/a1/attachments",
  });
  assert.equal(resolvePlaceholder("literal", folders), null);
});

test("an agent id that could leave the workspace root has no folders", () => {
  for (const id of ["", "..", "a/b", "../x", "-x", null])
    assert.equal(agentFolders(root, id), null);
  assert.equal(agentFolders(null, "a1"), null);
  assert.equal(agentFolders("relative", "a1"), null);
});

test("every resolved path stays inside the agent's own workspace", () => {
  const segment = fc
    .array(fc.constantFrom("a", ".", "..", "/", "\\", "%2e", "~", " ", "\0", "b"), {
      minLength: 1,
      maxLength: 6,
    })
    .map((parts) => parts.join(""));
  fc.assert(
    fc.property(
      fc.constantFrom("{agent.workspace}", "{agent.attachments}"),
      fc.array(segment, { maxLength: 5 }),
      (head, segments) => {
        const value = [head, ...segments].join("/");
        const resolved = resolvePlaceholder(value, folders);
        if (resolved === null || resolved === false) return;
        const own = folders["agent.workspace"];
        assert.ok(
          resolved.path === own || resolved.path.startsWith(own + path.sep),
          value,
        );
      },
    ),
    { numRuns: 3000 },
  );
});

test("a stdio server's placeholders: in arguments, cwd and environment only", () => {
  const server = {
    transport: "stdio",
    args: ["--base={agent.workspace}/voice", "plain"],
    cwd: "{agent.workspace}",
  };
  const env = { ELEVENLABS_MCP_BASE_PATH: "{agent.attachments}", KEY: "secret" };
  assert.equal(usesAgentPlaceholders(server, env), true);
  assert.equal(usesAgentPlaceholders({ ...server, args: [], cwd: null }, env), true);
  assert.equal(usesAgentPlaceholders({ ...server, args: [], cwd: null }, {}), false);
  assert.equal(usesAgentPlaceholders({ transport: "http", url: "x" }, {}), false);
  assert.deepEqual(placeholderTemplates(server, env), {
    args: [{ index: 0, template: "--base={agent.workspace}/voice" }],
    cwd: "{agent.workspace}",
    env: { ELEVENLABS_MCP_BASE_PATH: "{agent.attachments}" },
  });
  const resolved = resolveStdioServer(server, env, folders);
  assert.deepEqual(resolved.server.args, [
    "--base=/data/assistants/workspaces/a1/voice",
    "plain",
  ]);
  assert.equal(resolved.server.cwd, "/data/assistants/workspaces/a1");
  assert.deepEqual(resolved.env, {
    ELEVENLABS_MCP_BASE_PATH: "/data/assistants/workspaces/a1/attachments",
    KEY: "secret",
  });
  assert.deepEqual(resolved.paths.sort(), [
    "/data/assistants/workspaces/a1",
    "/data/assistants/workspaces/a1/attachments",
    "/data/assistants/workspaces/a1/voice",
  ]);
  // A stored value that no longer parses compiles nothing for the agent.
  assert.equal(
    resolveStdioServer({ ...server, cwd: "{agent.nope}" }, env, folders),
    null,
  );
});

const refusal = (input) => {
  try {
    requireValidPlaceholders(input);
  } catch (error) {
    return {
      code: error.code,
      status: error.status,
      field: error.field,
      names: error.names,
    };
  }
  return null;
};

test("input validation names the field and the environment names, never a value", () => {
  assert.equal(
    refusal({
      transport: "stdio",
      args: ["--dir={agent.workspace}"],
      cwd: "{agent.attachments}/x",
      env: { BASE: "{agent.workspace}", OTHER: "plain" },
    }),
    null,
  );
  assert.deepEqual(
    refusal({
      transport: "stdio",
      env: { A: "{agent.workspce}", B: "ok", C: "{session.cwd}" },
    }),
    { code: PLACEHOLDER, status: 400, field: "env", names: ["A", "C"] },
  );
  assert.deepEqual(refusal({ transport: "stdio", args: ["{agent.workspace}/.."] }), {
    code: PLACEHOLDER,
    status: 400,
    field: "args",
    names: [],
  });
  // No prefix in the working directory or the environment.
  assert.equal(refusal({ transport: "stdio", cwd: "x{agent.workspace}" }).field, "cwd");
  assert.equal(
    refusal({ transport: "stdio", env: { A: "=x{agent.workspace}" } }).field,
    "env",
  );
  // Never in the command, a URL or a header, and never for a remote server.
  assert.equal(
    refusal({ transport: "stdio", command: "{agent.workspace}/x" }).field,
    "command",
  );
  assert.equal(
    refusal({ transport: "http", url: "https://x/{agent.workspace}" }).field,
    "url",
  );
  assert.deepEqual(
    refusal({ transport: "http", headers: { "X-Dir": "{agent.workspace}" } }).names,
    ["X-Dir"],
  );
  // Removing an environment value (null) is never refused.
  assert.equal(refusal({ transport: "stdio", env: { A: null } }), null);
});
