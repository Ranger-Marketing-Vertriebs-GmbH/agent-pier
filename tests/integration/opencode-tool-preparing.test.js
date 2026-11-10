import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { applicationFixture } from "../helpers/application.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";
import { nativePushValue } from "../../server/features/requests/native-push.js";
import { streamOpenCodeReplies } from "../../server/features/sessions/opencode-reply-stream.js";

// OpenCode's pending tool part (the model writes the call's input) reaches the
// chat as the live status `preparing`, by name only, and ends when the call runs.
const sessionId = "opencode-preparing";

async function until(predicate, message, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}

async function fixture(t, tool = "opencode") {
  const f = await applicationFixture(t);
  const app = f.application;
  const session = { id: sessionId, accountId: "fixture", tool, status: "running" };
  app.sessions.get = async () => ({ ...session });
  app.chatStreams.watch = () => () => {};
  app.chatStreams.watchInput = () => () => {};
  app.chatStreams.settleMs = 600000;
  const snapshot = { messages: [{ id: "u1", role: "user", text: "Go" }], tasks: [] };
  app.chat.read = async () => structuredClone(snapshot);
  app.chatImages.decorate = async (_id, value) => value;
  app.chatImages.read = async () => structuredClone(snapshot);
  const launch = await app.requests.prepare({
    id: sessionId,
    account: { id: "fixture", tool },
    cwd: f.home,
    launch: { command: "/fixture/cli", args: [], env: {} },
  });
  const channel = new NativeRequestChannel({ env: launch.env });
  t.after(() => channel.close());
  await channel.ready;
  const ws = new WebSocket(
    `${f.url.replace("http:", "ws:")}/api/sessions/${sessionId}/chat-stream`,
    { origin: f.url, headers: { cookie: f.cookie } },
  );
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  t.after(() => ws.terminate());
  await until(() => frames.some((frame) => frame.type === "sync"), "no sync");
  const statuses = () => frames.filter((frame) => frame.type === "live-status");
  return {
    app,
    channel,
    status: () => statuses().at(-1)?.status,
    statuses,
  };
}

function openCode() {
  const handlers = new Map();
  const api = {
    event: {
      on: (type, handler) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    },
    state: {
      session: { messages: () => [{ id: "msg_1", role: "assistant" }] },
      part: () => [{ id: "prt_text", type: "text" }],
    },
  };
  const emit = (type, properties) => handlers.get(type)({ type, properties });
  const tool = (id, status, name = "bash", sessionID = "ses_1") =>
    emit("message.part.updated", {
      sessionID,
      part: {
        id,
        sessionID,
        messageID: "msg_1",
        type: "tool",
        tool: name,
        callID: `call_${id}`,
        state: { status, input: { command: "secret --token" }, raw: '{"command":"sec' },
      },
    });
  return { api, emit, tool };
}

test("a pending OpenCode tool part shows as preparing until the call runs", async (t) => {
  const s = await fixture(t);
  const oc = openCode();
  t.after(streamOpenCodeReplies(oc.api, s.channel, () => "ses_1"));
  oc.tool("prt_1", "pending", "edit");
  await until(() => s.status()?.preparing === "edit", "preparing");
  assert.equal(s.status().state, "working");
  assert.doesNotMatch(JSON.stringify(s.statuses()), /secret|command/, "name only");
  // A subagent's (another session's) tool part stays out.
  oc.tool("prt_2", "pending", "webfetch", "ses_child");
  oc.tool("prt_1", "running", "edit");
  await until(() => s.status() === null, "cleared when the call runs");
  assert.ok(!s.statuses().some((frame) => frame.status?.preparing === "webfetch"));
});

test("parallel parts: the newest still pending shows until each runs", async (t) => {
  const s = await fixture(t);
  const oc = openCode();
  t.after(streamOpenCodeReplies(oc.api, s.channel, () => "ses_1"));
  oc.tool("prt_a", "pending", "read");
  oc.tool("prt_b", "pending", "edit");
  await until(() => s.status()?.preparing === "edit", "newest");
  oc.tool("prt_b", "running", "edit");
  await until(() => s.status()?.preparing === "read", "the older one still writes");
  oc.tool("prt_a", "running", "read");
  await until(() => s.status() === null, "both run");
});

test("a part that runs after the TUI switched sessions still ends its preparation", async (t) => {
  const s = await fixture(t);
  const oc = openCode();
  let visible = "ses_1";
  t.after(streamOpenCodeReplies(oc.api, s.channel, () => visible));
  oc.tool("prt_a", "pending", "bash");
  await until(() => s.status()?.preparing === "bash", "preparing");
  visible = "ses_2";
  oc.tool("prt_a", "completed", "bash");
  await until(() => s.status() === null, "cleared from the hidden session");
});

test("text, the message's end, an idle session or an abort end the preparation", async (t) => {
  const s = await fixture(t);
  const oc = openCode();
  t.after(streamOpenCodeReplies(oc.api, s.channel, () => "ses_1"));
  const ends = [
    () =>
      oc.emit("message.part.delta", {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_text",
        field: "text",
        delta: "Done",
      }),
    () =>
      oc.emit("message.updated", {
        info: {
          id: "msg_1",
          sessionID: "ses_1",
          role: "assistant",
          time: { completed: 2 },
        },
      }),
    () => oc.emit("session.idle", { sessionID: "ses_1" }),
    () => oc.tool("prt_1", "error"),
  ];
  for (const [index, end] of ends.entries()) {
    oc.tool("prt_1", "pending", `mcp_tool_${index}`);
    await until(() => s.status()?.preparing === `mcp_tool_${index}`, `prepare ${index}`);
    end();
    await until(() => s.status() === null, `cleared ${index}`);
  }
});

test("a disconnected plugin's preparation ends with it", async (t) => {
  const s = await fixture(t);
  s.channel.preparing("bash");
  await until(() => s.status()?.preparing === "bash", "preparing");
  s.channel.close();
  await until(() => s.status() === null, "cleared on disconnect");
});

test("only an OpenCode owner reports preparing, and the push is checked", async (t) => {
  const s = await fixture(t, "codex");
  s.channel.preparing("bash");
  s.channel.streamDelta("item-1", "x", { turn: "turn-1" });
  await until(() => s.app.chatStreams.replies.runs(sessionId)["item-1"], "stream");
  assert.equal(s.statuses().length, 0);
  assert.deepEqual(nativePushValue({ type: "preparing", name: "bash" }), {
    type: "preparing",
    name: "bash",
  });
  assert.deepEqual(nativePushValue({ type: "preparing" }), { type: "preparing" });
  for (const name of ["", "a\nb", 3, "x".repeat(121)])
    assert.throws(() => nativePushValue({ type: "preparing", name }));
});
