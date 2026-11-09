import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

// AGENTPIER-367: a restricted user's own Hermes agent (a user agent, not shared) reads
// with its file and vision tools only its work folder and its own chat folders, as a
// shared one reads only its work folder and the calling chat's folder: never another
// agent's work folder, chat files or Hermes home. The owner's own agents keep Hermes's
// reads (hermes-home-guard.js userReadRefusal).

const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
const own = { mode: "own", members: [{ userId: "u1", level: "chat" }] };

function setup(t, userAccess = own, { fleet = true } = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "user-reads-")));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = {};
  if (fleet) attachHermesFleet(supervisor, new HermesFleet({ dataDir }));
  const agent = {
    id: "m1",
    runtime: "hermes",
    runtimeAgentId: "ap-m1",
    ...(userAccess && { userAccess }),
  };
  const paths = hermesPaths(dataDir);
  const write = (file, text = "x") => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const workspace = path.join(paths.agentWorkspaces, "m1");
  const otherWorkspace = path.join(paths.agentWorkspaces, "m2");
  const chats = path.join(dataDir, "assistants", "chat-files");
  write(path.join(workspace, "notes.md"));
  write(path.join(otherWorkspace, "secret.md"));
  const bridge = {
    assistants: {
      runtime: supervisor,
      attachments: { config: { workspaces: paths.agentWorkspaces } },
    },
    agentOf: (id) => (id === "ap-m1" ? agent : null),
    attachmentPolicy: () => ({ allow: true }),
    callingChat: () => ({ conversation: { id: "chat-a", assistantId: "m1" } }),
  };
  const guard = (toolName, args) =>
    hermesGuard(bridge, {
      agentId: "ap-m1",
      sessionKey: "agent:ap-m1:hermes:s1",
      toolName,
      args,
    });
  return {
    guard,
    write,
    dataDir,
    workspace,
    otherWorkspace,
    chats,
    hermesHome: path.join(paths.state, "ap-m1"),
    otherHome: path.join(paths.state, "ap-m2"),
    home: path.join(paths.home, "ap-m1"),
  };
}
const allowed = { allow: true };
const refused = { allow: false, message: homeRefusal };
// The path with every folder below the data directory's parent in upper case.
const upper = (file) => {
  const base = path.dirname(path.dirname(file).split("/assistants/")[0]);
  return base + file.slice(base.length).toUpperCase();
};

test("a user's own agent reads no other agent's folders, by any spelling", async (t) => {
  const f = setup(t);
  const secret = path.join(f.otherWorkspace, "secret.md");
  const otherImage = f.write(path.join(f.otherHome, "cache", "images", "u.png"));
  const ownCache = f.write(path.join(f.hermesHome, "cache", "images", "u.png"));
  // A link in its own work folder to another agent's.
  fs.symlinkSync(f.otherWorkspace, path.join(f.workspace, "door"));
  for (const [tool, args] of [
    ["read_file", { path: secret }],
    ["read_file", { path: upper(secret) }],
    ["read_file", { path: "../m2/secret.md" }],
    ["read_file", { path: "door/secret.md" }],
    ["read_file", { path: path.join(f.workspace, "door", "secret.md") }],
    ["read_file", { path: "~/../../state/ap-m2/state.db" }],
    ["read_file", { path: "~/x" }],
    ["read_file", { path: path.join(f.home, "x") }],
    ["read_file", { path: path.join(f.hermesHome, "state.db") }],
    ["read_file", { path: ownCache }],
    ["read_file", { path: "/etc/hosts" }],
    ["read_file", { path: "~root/x" }],
    ["vision_analyze", { image_url: otherImage }],
    ["vision_analyze", { image_url: `file://${otherImage}` }],
    ["vision_analyze", { image_url: `FILE://${upper(otherImage)}` }],
    ["vision_analyze", { image_url: "file://../m2/secret.md" }],
    // Another agent's chat files.
    ["read_file", { path: f.write(path.join(f.chats, "m2", "chat-c", "x.pdf")) }],
    // A search whose folder is the root, an ancestor or another agent's folder.
    ["search_files", { path: "/", pattern: "x" }],
    ["search_files", { path: "..", pattern: "x" }],
    ["search_files", { path: f.dataDir, pattern: "x" }],
    ["search_files", { path: path.dirname(f.workspace), pattern: "x" }],
    ["search_files", { path: f.otherWorkspace, pattern: "x" }],
    ["search_files", { path: "door", pattern: "x" }],
    ["search_files", { path: f.chats, pattern: "x" }],
    ["search_files", { path: "~", target: "files", pattern: "*" }],
  ])
    assert.deepEqual(
      await f.guard(tool, args),
      refused,
      `${tool} ${JSON.stringify(args)}`,
    );
});

test("a user's own agent reads its work folder and all of its own chat folders", async (t) => {
  const f = setup(t);
  const mine = f.write(path.join(f.chats, "m1", "chat-a", "a.pdf"));
  const earlier = f.write(path.join(f.chats, "m1", "chat-b", "b.pdf"));
  const made = f.write(path.join(f.chats, "m1", "chat-b", "generated-images", "i.png"));
  for (const [tool, args] of [
    ["read_file", { path: "notes.md" }],
    ["read_file", { path: path.join(f.workspace, "notes.md") }],
    ["search_files", { pattern: "x" }],
    ["search_files", { path: ".", pattern: "x" }],
    ["search_files", { path: f.workspace, pattern: "x" }],
    ["read_file", { path: mine }],
    ["read_file", { path: earlier }],
    ["vision_analyze", { image_url: made }],
    ["vision_analyze", { image_url: `file://${made}` }],
    ["vision_analyze", { image_url: "https://example.test/a.png" }],
    ["search_files", { path: path.join(f.chats, "m1"), pattern: "x" }],
  ])
    assert.deepEqual(
      await f.guard(tool, args),
      allowed,
      `${tool} ${JSON.stringify(args)}`,
    );
});

test("a shared agent still reads only the calling chat's folder", async (t) => {
  const f = setup(t, { mode: "shared", members: [] });
  const theirs = f.write(path.join(f.chats, "m1", "chat-b", "generated-images", "i.png"));
  assert.deepEqual(await f.guard("vision_analyze", { image_url: theirs }), refused);
  assert.deepEqual(
    await f.guard("read_file", { path: path.join(f.otherWorkspace, "secret.md") }),
    refused,
  );
  const mine = f.write(path.join(f.chats, "m1", "chat-a", "generated-images", "i.png"));
  assert.deepEqual(await f.guard("vision_analyze", { image_url: mine }), allowed);
});

test("a user's agent fails closed while its folders are unknown", async (t) => {
  const f = setup(t, own, { fleet: false });
  assert.deepEqual(await f.guard("read_file", { path: "/etc/hosts" }), refused);
});

test("the owner's own agent keeps Hermes's reads", async (t) => {
  const f = setup(t, null);
  for (const [tool, args] of [
    ["read_file", { path: path.join(f.otherWorkspace, "secret.md") }],
    ["read_file", { path: path.join(f.hermesHome, "state.db") }],
    ["search_files", { path: "/", pattern: "x" }],
  ])
    assert.deepEqual(
      await f.guard(tool, args),
      allowed,
      `${tool} ${JSON.stringify(args)}`,
    );
});

test(
  "a user's own agent's plugin asks before every read leaving its work folder",
  { skip: !python && "python3 is not installed" },
  async (t) => {
    const profile = (extra = {}) =>
      desiredAgent({ id: "a1", runtimeAgentId: "ap-a1", revision: 1, ...extra });
    // AgentPier is not reachable: nothing answers on the bridge's port.
    const connection = { url: "http://127.0.0.1:9", token: "k" };
    const ownAgent = profile({ userAccess: own });
    const settings = (agent) =>
      JSON.parse(
        teamPluginFiles(agent, { connection })["plugins/agentpier-team/tools.json"],
      );
    assert.equal(settings(ownAgent).privateFolders, true);
    assert.equal(settings(profile()).privateFolders, undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-reads-plugin-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [file, text] of Object.entries(
      teamPluginFiles(ownAgent, { connection }),
    )) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    const run = async (args, tool = "read_file") => {
      const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
print(json.dumps(plugin._guard(sys.argv[3], json.loads(sys.argv[2]), session_id="s1")))
`;
      const { stdout } = await promisify(execFile)(python, [
        "-I",
        "-c",
        script,
        path.join(dir, "plugins/agentpier-team/__init__.py"),
        JSON.stringify(args),
        tool,
      ]);
      return JSON.parse(stdout);
    };
    const blocked = {
      action: "block",
      message: "AgentPier is not reachable right now; try again shortly.",
    };
    for (const [args, tool] of [
      [{ path: "/data/assistants/workspaces/m2/secret.md" }, "read_file"],
      [{ path: "~/x" }, "read_file"],
      [{ path: "../m2/x" }, "read_file"],
      [{ image_url: "file:///x.png" }, "vision_analyze"],
      [{ pattern: "x" }, "search_files"],
      [{ path: "/", pattern: "x" }, "search_files"],
    ])
      assert.deepEqual(await run(args, tool), blocked, JSON.stringify(args));
    assert.equal(await run({ path: "notes.md" }), null);
  },
);
