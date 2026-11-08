import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { hermesGuard } from "../../server/features/assistants/hermes-tool-guard.js";
import { homeRefusal } from "../../server/features/assistants/hermes-home-guard.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";
import { hermesPaths } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { teamPluginFiles } from "../../server/features/assistants/runtimes/hermes/hermes-config/team-plugin.js";

// On a Hermes agent shared with users each chat is private to its person; the
// gateway keeps every chat's images in the agent's HERMES_HOME (cache/images,
// cache/documents/native-inputs), so its file and vision tools never read there
// (hermes-home-guard.js), as an OpenClaw agent reads only its workspace.

const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;

function guardBridge(t, userAccess) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-")));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = {};
  attachHermesFleet(supervisor, new HermesFleet({ dataDir }));
  const agent = {
    id: "m1",
    runtime: "hermes",
    runtimeAgentId: "ap-m1",
    ...(userAccess && { userAccess }),
  };
  const bridge = {
    assistants: { runtime: supervisor },
    agentOf: (id) => (id === "ap-m1" ? agent : null),
    attachmentPolicy: () => ({ allow: true }),
    callingChat: () => ({}),
  };
  const paths = hermesPaths(dataDir);
  const hermesHome = path.join(paths.state, "ap-m1");
  const cache = path.join(hermesHome, "cache", "documents", "native-inputs", "ab");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, "upload_1.png"), "x");
  return { bridge, dataDir, hermesHome, home: path.join(paths.home, "ap-m1"), cache };
}
const guard = (bridge, toolName, args) =>
  hermesGuard(bridge, {
    agentId: "ap-m1",
    sessionKey: "agent:ap-m1:hermes:s1",
    toolName,
    args,
  });
const refused = { allow: false, message: homeRefusal };

test("a shared agent reads nothing of its runtime folders, by any spelling", async (t) => {
  const { bridge, dataDir, hermesHome, home, cache } = guardBridge(t, {
    mode: "shared",
    members: [],
  });
  const image = path.join(cache, "upload_1.png");
  for (const [tool, args] of [
    ["read_file", { path: image }],
    ["read_file", { path: path.join(hermesHome, "state.db") }],
    [
      "read_file",
      { path: `../../hermes/state/ap-m1/cache/documents/native-inputs/ab/upload_1.png` },
    ],
    ["read_file", { path: "~/.bash_history" }],
    ["read_file", { path: path.join(home, "x") }],
    ["vision_analyze", { image_url: image }],
    ["vision_analyze", { image_url: `file://${image}` }],
    // A search whose folder holds them.
    ["search_files", { path: "/", pattern: "upload_" }],
    ["search_files", { path: dataDir }],
    ["search_files", { path: path.join(hermesHome, "cache") }],
  ])
    assert.deepEqual(
      await guard(bridge, tool, args),
      refused,
      `${tool} ${JSON.stringify(args)}`,
    );
  // Its own work folder and web images stay readable.
  for (const [tool, args] of [
    ["read_file", { path: "notes.md" }],
    ["search_files", { pattern: "TODO" }],
    ["search_files", { path: "src" }],
    ["vision_analyze", { image_url: "https://example.test/a.png" }],
  ])
    assert.deepEqual(await guard(bridge, tool, args), { allow: true }, tool);
});

test("an agent not shared with users keeps Hermes's own reads", async (t) => {
  const { bridge, cache } = guardBridge(t, null);
  assert.deepEqual(
    await guard(bridge, "read_file", { path: path.join(cache, "upload_1.png") }),
    { allow: true },
  );
  assert.deepEqual(await guard(bridge, "search_files", { path: "/" }), { allow: true });
});

test(
  "a shared agent's plugin asks the bridge before every read",
  { skip: !python && "python3 is not installed" },
  async (t) => {
    const profile = (extra = {}) =>
      desiredAgent({ id: "a1", runtimeAgentId: "ap-a1", revision: 1, ...extra });
    const shared = profile({ userAccess: { mode: "shared", members: [] } });
    const settings = (agent, connection) =>
      JSON.parse(
        teamPluginFiles(agent, { connection })["plugins/agentpier-team/tools.json"],
      );
    const offline = { url: "http://127.0.0.1:9", token: "k" };
    assert.equal(settings(shared, offline).privateFolders, true);
    assert.equal(settings(profile(), offline).privateFolders, undefined);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-plugin-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const seen = [];
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ allow: false, message: homeRefusal }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const connection = { url: `http://127.0.0.1:${server.address().port}`, token: "k" };
    const run = async (agent, args) => {
      for (const [file, text] of Object.entries(teamPluginFiles(agent, { connection }))) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), text);
      }
      const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
print(json.dumps(plugin._guard("read_file", json.loads(sys.argv[2]), session_id="s1")))
`;
      const { stdout } = await promisify(execFile)(python, [
        "-I",
        "-c",
        script,
        path.join(dir, "plugins/agentpier-team/__init__.py"),
        JSON.stringify(args),
      ]);
      return JSON.parse(stdout);
    };
    // A path that names no attachments/ still asks on a shared agent.
    assert.deepEqual(await run(shared, { path: "/x/cache/images/u.png" }), {
      action: "block",
      message: homeRefusal,
    });
    assert.equal(seen.at(-1).toolName, "read_file");
    const before = seen.length;
    assert.equal(await run(profile(), { path: "/x/cache/images/u.png" }), null);
    assert.equal(seen.length, before);
  },
);
