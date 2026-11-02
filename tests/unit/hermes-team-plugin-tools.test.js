import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import {
  teamPluginFiles,
  teamTools,
} from "../../server/features/assistants/runtimes/hermes/hermes-config/team-plugin.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";

const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;

test("a Hermes agent holds AgentPier's own tools as an OpenClaw agent does", () => {
  const own = desiredAgent({
    id: "a1",
    runtimeAgentId: "ap-a1",
    revision: 1,
    capabilities: { reminders: true },
  });
  const names = teamTools(own).map((tool) => tool.name);
  for (const name of [
    "agentpier_reminder",
    "agentpier_routine",
    "agentpier_hook",
    "agentpier_workspace",
    "agentpier_share_file",
    "agentpier_goal",
    "agentpier_team_propose",
  ])
    assert.ok(names.includes(name), name);
  // A restricted user's agent keeps OpenClaw's lock: no team, SSH, goal or mail tools.
  const user = desiredAgent({
    id: "u1",
    runtimeAgentId: "ap-u1",
    revision: 1,
    userAccess: { userId: "x" },
    capabilities: { reminders: true },
  });
  const locked = teamTools(user).map((tool) => tool.name);
  assert.ok(locked.includes("agentpier_share_file"));
  for (const name of ["agentpier_goal", "agentpier_mail", "agentpier_team_propose"])
    assert.equal(locked.includes(name), false, name);
  assert.deepEqual(teamTools(desiredAgent({ ...own, archivedAt: "x" })), []);
});

// Loads the compiled plugin in Python against a local bridge and calls one tool.
async function callTool(t, { name, args, sessionId, taskId, answer }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-team-tools-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/prepare" ? { ticket: "t1" } : answer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const agent = desiredAgent({ id: "a1", runtimeAgentId: "ap-a1", revision: 1 });
  const files = teamPluginFiles(agent, {
    connection: { url: `http://127.0.0.1:${server.address().port}`, token: "k" },
  });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
tools = {}
class Ctx:
    def register_tool(self, name, handler, **_):
        tools[name] = handler
    def register_hook(self, *_):
        pass
plugin.register(Ctx())
extra = {"task_id": sys.argv[5]} if len(sys.argv) > 5 else {}
print(tools[sys.argv[2]](json.loads(sys.argv[3]), session_id=sys.argv[4], **extra))
`;
  const { stdout } = await promisify(execFile)(python, [
    "-I",
    "-c",
    script,
    path.join(dir, "plugins/agentpier-team/__init__.py"),
    name,
    JSON.stringify(args),
    sessionId,
    ...(taskId ? [taskId] : []),
  ]);
  return { result: JSON.parse(stdout), seen };
}

test(
  "a routine run's tool call names its run session and a project image stays a file",
  { skip: !python && "python3 is not installed" },
  async (t) => {
    const routine = await callTool(t, {
      name: "agentpier_share_file",
      args: { path: "report.md" },
      sessionId: "local-5f2a",
      taskId: "cron:abc123def456:e1",
      answer: { ok: true },
    });
    assert.deepEqual(routine.result, { ok: true });
    const [prepare, invoke] = routine.seen;
    assert.equal(prepare.url, "/prepare");
    assert.equal(
      prepare.body.sessionKey,
      "agent:ap-a1:hermes:cron:abc123def456:local-5f2a",
    );
    assert.equal(prepare.body.action, "share_file");
    assert.deepEqual(invoke.body, {
      ticket: "t1",
      action: "share_file",
      input: { path: "report.md" },
    });
    const chat = await callTool(t, {
      name: "agentpier_workspace",
      args: { action: "image_view", projectId: "p1", path: "a.png" },
      sessionId: "20261102_090000_abcd",
      answer: { path: "a.png", projectId: "p1", mimeType: "image/png", data: "AAAA" },
    });
    assert.equal(chat.seen[0].body.sessionKey, "agent:ap-a1:hermes:20261102_090000_abcd");
    assert.equal(chat.result.data, undefined);
    assert.equal(chat.result.mimeType, "image/png");
    assert.match(chat.result.note, /read the file/);
  },
);

test("a restricted user's Hermes agent runs no subagents and reads no other chats", () => {
  const toolsets = (profile) =>
    readHermesConfig(compileHome(desiredAgent(profile)).files["config.yaml"]).agent
      .disabled_toolsets;
  const user = toolsets({
    id: "u1",
    runtimeAgentId: "ap-u1",
    revision: 1,
    userAccess: { userId: "x" },
  });
  for (const name of ["connections", "delegation", "session_search", "terminal"])
    assert.ok(user.includes(name), name);
  const own = toolsets({ id: "a1", runtimeAgentId: "ap-a1", revision: 1 });
  assert.equal(own.includes("delegation"), false);
  assert.equal(own.includes("session_search"), false);
});
