import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { AgentShares } from "../../server/features/assistants/agent-shares.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";
import { hermesPaths } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { teamPluginFiles } from "../../server/features/assistants/runtimes/hermes/hermes-config/team-plugin.js";
import { png } from "../helpers/image-bytes.js";

// AGENTPIER-366: an image a Hermes agent created is shared into the chat its turn,
// routine or hook shares into, and kept for the agent in that chat's file folder
// (hermes-generated-images.js), never in its work folder, which every chat of a
// shared agent searches.

const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;

function setup(t, { runtime = "hermes" } = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gen-images-")));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = {};
  attachHermesFleet(supervisor, new HermesFleet({ dataDir }));
  const paths = hermesPaths(dataDir);
  const agent = { id: "m1", runtime, runtimeAgentId: "ap-m1" };
  const conversation = { id: "chat-a", assistantId: "m1" };
  const cache = path.join(paths.state, "ap-m1", "cache", "generated", "images");
  fs.mkdirSync(cache, { recursive: true });
  const shared = [];
  const audits = [];
  const assistants = {
    runtime: supervisor,
    store: {
      getAssistant: () => agent,
      getConversation: () => conversation,
    },
    attachments: {
      config: { workspaces: paths.agentWorkspaces },
      share: async (input) => {
        shared.push(input);
        return { id: "f1", name: input.name, type: "image/png", size: input.body.length };
      },
    },
    audit: { append: (entry) => audits.push(entry) },
  };
  const shares = new AgentShares({ assistants });
  shares.turn = () => ({
    conversation,
    requestId: "r1",
    origin: { kind: "owner" },
  });
  const invocation = { assertCurrent() {} };
  return {
    cache,
    shared,
    audits,
    invoke: (input) => shares.invoke(invocation, input),
    chatFolder: path.join(dataDir, "assistants", "chat-files", "m1", "chat-a"),
    workspace: path.join(paths.agentWorkspaces, "m1"),
  };
}
const name = "openai_codex_20261109_101500_ab12cd34.png";

test("a created image is shared and kept in the chat's own file folder", async (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.cache, name), png);
  const result = await f.invoke({ generated: name });
  const kept = path.join(f.chatFolder, "generated-images", name);
  assert.equal(result.status, "shared");
  assert.equal(result.image, kept);
  assert.deepEqual(fs.readFileSync(kept), png);
  assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(kept)), [name]);
  assert.equal(f.shared.length, 1);
  assert.equal(f.shared[0].name, name);
  assert.deepEqual(f.shared[0].body, png);
  assert.equal(f.shared[0].path, undefined);
  assert.equal(f.audits[0].details.kind, "generated-image");
  // Nothing lands in the work folder.
  assert.equal(fs.existsSync(path.join(f.workspace, "generated-images")), false);
});

test("a link at the copy's name is replaced, never followed", async (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.cache, name), png);
  const folder = path.join(f.chatFolder, "generated-images");
  fs.mkdirSync(folder, { recursive: true });
  const outside = path.join(path.dirname(f.cache), "outside.txt");
  fs.writeFileSync(outside, "keep");
  fs.symlinkSync(outside, path.join(folder, name));
  await f.invoke({ generated: name });
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert.equal(fs.lstatSync(path.join(folder, name)).isSymbolicLink(), false);
});

test("only a file of the agent's own image cache is taken", async (t) => {
  const f = setup(t);
  const elsewhere = path.join(path.dirname(f.cache), "elsewhere.png");
  fs.writeFileSync(elsewhere, png);
  fs.symlinkSync(elsewhere, path.join(f.cache, "linked.png"));
  for (const input of [
    { generated: "../elsewhere.png" },
    { generated: "linked.png" },
    { generated: "missing.png" },
    { generated: "notes.txt" },
    { generated: name, path: "x.png" },
    { generated: 7 },
  ])
    await assert.rejects(f.invoke(input), undefined, JSON.stringify(input));
  assert.equal(f.shared.length, 0);
  assert.equal(fs.existsSync(f.chatFolder), false);
});

test("an OpenClaw agent passes no created image by name", async (t) => {
  const f = setup(t, { runtime: "openclaw" });
  fs.writeFileSync(path.join(f.cache, name), png);
  await assert.rejects(f.invoke({ generated: name }), { key: "invalid" });
});

test(
  "the plugin's image hook hands the image over by name and names the chat's copy",
  { skip: !python && "python3 is not installed" },
  async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gen-images-plugin-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const bodies = [];
    let answer = null;
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      bodies.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/prepare" ? { ticket: "t1" } : answer));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const connection = { url: `http://127.0.0.1:${server.address().port}`, token: "k" };
    const agent = desiredAgent({ id: "a1", runtimeAgentId: "ap-a1", revision: 1 });
    for (const [file, text] of Object.entries(
      teamPluginFiles(agent, { connection, images: true }),
    )) {
      fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
      fs.writeFileSync(path.join(home, file), text);
    }
    const cache = path.join(home, "cache", "generated", "images");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, name), png);
    const run = async (image) => {
      const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
result = json.dumps({"success": True, "image": sys.argv[2]})
print(plugin._image_result("image_generate", result, session_id="s1") or "null")
`;
      const { stdout } = await promisify(execFile)(python, [
        "-I",
        "-c",
        script,
        path.join(home, "plugins/agentpier-team/__init__.py"),
        image,
      ]);
      return JSON.parse(stdout);
    };
    answer = { status: "shared", image: "/chats/a1/c1/generated-images/x.png", note: "" };
    const done = await run(path.join(cache, name));
    assert.equal(done.image, answer.image);
    assert.match(done.note, /handed this image over/);
    assert.deepEqual(bodies.at(-1), {
      url: "/invoke",
      body: { ticket: "t1", action: "share_file", input: { generated: name } },
    });
    answer = { error: "UNAVAILABLE_X: down" };
    const failed = await run(path.join(cache, name));
    assert.equal(failed.image, undefined);
    assert.match(failed.note, /could not hand this image over/);
    // A file outside the image cache is left alone.
    const asked = bodies.length;
    assert.equal(await run(path.join(home, "other.png")), null);
    assert.equal(bodies.length, asked);
  },
);
