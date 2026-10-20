import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { ReplyStreams } from "../../server/features/chat/reply-streams.js";
import { ClaudeModBridge } from "../../server/features/claude-mod/claude-mod-bridge.js";
import { CLAUDE_MOD_VERSION } from "../../server/features/claude-mod/claude-mod-launch.js";
import { nextReplies } from "../../web/features/chat/reply-stream.js";
import { fakeModRuntime } from "../helpers/fake-mod-runtime.js";
import { until } from "../helpers/adapter-process.js";

const TURN = "0c9e6a2f-7d41-4f4e-9a15-3f4f7c2b8d10";

// `$.http.fetch` with `socketPath`, as Claude Code's host performs it.
function unixFetch({ url, socketPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, path: new URL(url).pathname, method, headers },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            ok: response.statusCode < 300,
            headers: response.headers,
            text,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function setup(t, { cliVersion = "2.1.304", status = "running" } = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-mod-")));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session = { id: "s", accountId: "account", tool: "claude", status };
  const frames = [];
  const replies = new ReplyStreams({ flushMs: 1 });
  t.after(() => replies.close());
  replies.subscribe("s", (frame) => frames.push(frame));
  const drafts = [];
  const mod = new ClaudeModBridge({
    streams: {
      streamText: (...a) => replies.streamText(...a),
      endStream: (...a) => replies.endStream(...a),
      setStatus: (...a) => replies.setStatus(...a),
    },
    drafts: { end: (id) => drafts.push(id) },
  });
  const broker = new RequestBroker({
    dataDir,
    sessions: { get: async () => ({ ...session }) },
    onNative: (id, push) => {
      if (push.type === "claude-mod") return mod.receive(id, push.events);
    },
    onLaunch: (id) => mod.forget(id),
  });
  t.after(() => broker.close());
  const launch = await broker.prepare({
    id: "s",
    account: { id: "account", tool: "claude" },
    cwd: dataDir,
    launch: { command: "/fixture/claude", args: [], env: {}, cliVersion },
  });
  return { broker, launch, mod, frames, session, drafts };
}

test("a Claude Code with mods gets the bridge plugin, its socket and the sandbox grant", async (t) => {
  const { broker, launch } = await setup(t);
  const index = launch.args.findIndex((arg) => arg.endsWith("s.claude-bridge"));
  assert.equal(launch.args[index - 1], "--plugin-dir");
  const directory = launch.args[index];
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, ".claude-plugin/plugin.json"), "utf8"),
  );
  assert.equal(manifest.name, "agentpier-bridge");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(directory, "hooks/hooks.json"), "utf8")),
    { modules: ["./register.js"] },
  );
  assert.match(
    fs.readFileSync(path.join(directory, "hooks/register.js"), "utf8"),
    /export const register/,
  );
  assert.equal(launch.env.AGENTPIER_CLAUDE_BRIDGE_SOCKET, broker.modSocketPath);
  assert.ok(broker.modSocketPath.length < 100, "fits a Unix socket address");
  assert.equal((fs.statSync(broker.modSocketPath).mode & 0o777).toString(8), "600");
  assert.ok(
    JSON.stringify(launch).includes(broker.modSocketPath),
    "the nono grant names the socket",
  );
  await broker.discard("s");
  assert.equal(fs.existsSync(directory), false);
});

test("an older or unknown Claude Code keeps the MessageDisplay path alone", async (t) => {
  for (const cliVersion of ["2.1.286", null]) {
    const { launch } = await setup(t, { cliVersion });
    assert.equal(
      launch.args.some((arg) => arg.endsWith(".claude-bridge")),
      false,
    );
    assert.equal(launch.env.AGENTPIER_CLAUDE_BRIDGE_SOCKET, undefined);
  }
  assert.equal(CLAUDE_MOD_VERSION, "2.1.287");
});

test("the real mod module streams a turn through the broker's socket", async (t) => {
  const { launch, mod, frames, drafts } = await setup(t);
  const runtime = fakeModRuntime({ env: launch.env, fetch: unixFetch });
  const directory = launch.args.find((arg) => arg.endsWith(".claude-bridge"));
  const { register } = await import(path.join(directory, "hooks/register.js"));
  register(runtime.on);
  await runtime.dispatch("session.start", {});
  await runtime.tick();
  await until(() => mod.active("s"), 2000);
  assert.deepEqual(drafts, ["s"]);
  await runtime.dispatch("turn.start", { turnId: TURN, text: "" });
  await runtime.dispatch(
    "tool.call",
    { tool: "Bash", tool_use_id: "toolu_1" },
    async () => {
      await runtime.tick();
      await until(() => mod.activity("s")?.state === "working", 2000);
      return { text: "ok" };
    },
  );
  for (const piece of ["Hel", "lo ", "world"]) {
    await runtime.stream("turn.step", { turnId: TURN, index: 1 }, [
      { kind: "text", index: 0, text: piece, ref: 1 },
    ]);
    await runtime.tick();
  }
  const fold = () =>
    frames.reduce((runs, frame) => nextReplies(runs, frame) || runs, new Map());
  await until(() => [...fold().values()][0]?.text === "Hello world", 2000);
  const statuses = frames.filter((frame) => frame.type === "live-status");
  assert.ok(statuses.some((frame) => frame.status?.tool === "Bash"));
  await runtime.dispatch("turn.complete", {
    turnId: TURN,
    answer: "Hello world",
    durationMs: 10,
    isAborted: false,
    reason: "answer",
  });
  await runtime.tick();
  await until(() => mod.activity("s")?.state === "idle", 2000);
  assert.equal([...fold().values()][0].ended, true);
});

test("the mod socket refuses foreign tokens, other tools and stopped sessions", async (t) => {
  const { broker, launch, session } = await setup(t);
  const send = (headers, body = { protocol: 1, events: [{ type: "hello" }] }) =>
    unixFetch({
      url: "http://agentpier/claude-mod/v1/events",
      socketPath: broker.modSocketPath,
      method: "POST",
      headers: { "x-agentpier-session": "s", ...headers },
      body,
    });
  const auth = { authorization: `Bearer ${launch.env.AGENTPIER_REQUEST_TOKEN}` };
  assert.equal((await send(auth)).status, 200);
  assert.equal((await send({ authorization: `Bearer ${"b".repeat(64)}` })).status, 401);
  assert.equal((await send({})).status, 401);
  assert.equal((await send({ ...auth, "x-agentpier-session": "../s" })).status, 401);
  assert.equal(
    (await send(auth, { protocol: 1, events: [{ type: "text" }] })).status,
    400,
  );
  session.status = "stopped";
  broker.modOwners.clear();
  assert.equal((await send(auth)).status, 410, "the mod stops reporting");
});
