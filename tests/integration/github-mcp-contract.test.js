import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  githubServerArgs,
  githubServerEnv,
} from "../../server/features/assistants/agent-github.js";
import { installGithubMcp } from "../../server/features/tools/github-mcp-installer.js";
import { run } from "../../server/features/tools/tool-run.js";

// Opt-in: the pinned github-mcp-server against a fake GitHub API. Either name an
// installed binary (AGENTPIER_GITHUB_MCP_BINARY) or let the test download and check
// the pinned release (AGENTPIER_GITHUB_MCP_CONTRACT=1; needs network).
const binary = process.env.AGENTPIER_GITHUB_MCP_BINARY;
const download = process.env.AGENTPIER_GITHUB_MCP_CONTRACT === "1";
const token = "ghp_contract_token_never_echoed";

async function serverBinary(t) {
  if (binary) return binary;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "github-mcp-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return (await installGithubMcp({ root, run, env: { PATH: "/usr/bin:/bin" } }))
    .executable;
}

// A GitHub Enterprise-style API over plain HTTP on loopback (GITHUB_HOST accepts it).
async function fakeGithub(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.setHeader("x-oauth-scopes", "repo");
    if (/\/repos\/octo\/app\/issues\/7$/.test(req.url))
      return res.end(
        JSON.stringify({ number: 7, title: "Fix login", state: "open", body: "Steps" }),
      );
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// Starts the server as the Gateway would (compiled command, args, env) and speaks
// MCP over stdio: initialize, list tools, call one.
function mcpClient(t, command, level, host) {
  const child = spawn(command, githubServerArgs(level), {
    env: { PATH: "/usr/bin:/bin", ...githubServerEnv(host, token) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "",
    buffer = "",
    next = 1;
  const waiting = new Map();
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at; (at = buffer.indexOf("\n")) >= 0;) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      waiting.get(message.id)?.(message);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    stderr: () => stderr,
    async start() {
      await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agentpier-contract", version: "1" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      return (await call("tools/list")).result.tools.map((tool) => tool.name);
    },
    call,
  };
}

test(
  "the pinned GitHub MCP server offers each level's tools and uses the token",
  { skip: !binary && !download, timeout: 300000 },
  async (t) => {
    const command = await serverBinary(t);
    const github = await fakeGithub(t);
    const read = mcpClient(t, command, "read", github.url);
    const readTools = await read.start();
    assert.ok(readTools.includes("issue_read"));
    assert.ok(readTools.includes("actions_list"));
    for (const name of ["create_pull_request", "issue_write", "push_files"])
      assert.ok(!readTools.includes(name), name);
    const result = await read.call("tools/call", {
      name: "issue_read",
      arguments: { method: "get", owner: "octo", repo: "app", issue_number: 7 },
    });
    assert.match(result.result.content[0].text, /Fix login/);
    const call = github.requests.find((r) => r.url.endsWith("/issues/7"));
    assert.equal(call.url, "/api/v3/repos/octo/app/issues/7");
    assert.match(call.auth, new RegExp(`${token}$`));
    const write = mcpClient(t, command, "write", github.url);
    const writeTools = await write.start();
    for (const name of ["create_pull_request", "issue_write", "create_or_update_file"])
      assert.ok(writeTools.includes(name), name);
    assert.ok(!writeTools.includes("delete_repository"));
    assert.ok(!writeTools.some((name) => name.startsWith("actions_")));
    // The token never shows up in a tool result or the server's log output.
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    assert.doesNotMatch(read.stderr() + write.stderr(), new RegExp(token));
  },
);
