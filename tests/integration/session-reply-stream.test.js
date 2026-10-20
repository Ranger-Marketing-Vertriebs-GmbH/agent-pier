import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { applicationFixture } from "../helpers/application.js";
import { createCodexProxy } from "../../server/features/requests/codex-proxy.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";
import { streamOpenCodeReplies } from "../../server/features/sessions/opencode-reply-stream.js";
import { nextReplies, visibleReplies } from "../../web/features/chat/reply-stream.js";

const sessionId = "reply-stream-fixture";

async function until(predicate, message, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}

/** The whole application, a running session of `tool` and its native channel. */
async function fixture(t, tool) {
  const f = await applicationFixture(t);
  const app = f.application;
  const session = { id: sessionId, accountId: "fixture", tool, status: "running" };
  app.sessions.get = async (id) => {
    assert.equal(id, sessionId);
    return { ...session };
  };
  app.chatStreams.watch = () => () => {};
  app.chatStreams.watchInput = () => () => {};
  app.chatStreams.settleMs = 600000;
  let snapshot = {
    providerSessionId: "thread-main",
    messages: [{ id: "u1", role: "user", text: "Question" }],
    tasks: [],
  };
  let reads = 0;
  app.chat.read = async () => structuredClone(snapshot);
  app.chatImages.decorate = async (_id, value) => value;
  app.chatImages.read = async () => {
    reads++;
    return structuredClone(snapshot);
  };
  const launch = await app.requests.prepare({
    id: sessionId,
    account: { id: "fixture", tool },
    cwd: f.home,
    launch: { command: "/fixture/cli", args: [], env: {} },
  });
  const channel = new NativeRequestChannel({ env: launch.env });
  t.after(() => channel.close());
  await channel.ready;
  return {
    f,
    app,
    channel,
    reads: () => reads,
    transcript(messages) {
      snapshot = { ...snapshot, messages: [...snapshot.messages, ...messages] };
    },
    snapshot: () => snapshot,
  };
}

function connect(t, f) {
  const ws = new WebSocket(
    `${f.url.replace("http:", "ws:")}/api/sessions/${sessionId}/chat-stream`,
    { origin: f.url, headers: { cookie: f.cookie } },
  );
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  t.after(() => ws.terminate());
  return {
    frames,
    // The browser's own fold of the frames (reply-stream.js).
    runs() {
      let runs = new Map();
      for (const frame of frames)
        if (frame.type === "stream" || frame.type === "stream-end") {
          runs = nextReplies(runs, frame);
          assert.ok(runs, `frame does not fit: ${JSON.stringify(frame)}`);
        }
      return runs;
    },
  };
}

test("Codex agent message deltas stream to the chat and give way to the final message", async (t) => {
  const s = await fixture(t, "codex");
  const incoming = new PassThrough();
  const proxy = await createCodexProxy({
    input: incoming,
    output: new PassThrough(),
    channel: s.channel,
  });
  t.after(() => proxy.close());
  const notify = (method, params) =>
    incoming.write(JSON.stringify({ method, params }) + "\n");
  const first = connect(t, s.f);
  await until(() => first.frames.some((frame) => frame.type === "sync"), "no sync");
  const delta = (text, threadId = "thread-main") =>
    notify("item/agentMessage/delta", {
      threadId,
      turnId: "turn-1",
      itemId: threadId === "thread-main" ? "item-1" : "item-sub",
      delta: text,
    });
  delta("Hello");
  await until(() => first.runs().get("item-1")?.text === "Hello", "first delta");
  delta(" wor");
  delta("ld");
  delta("Sub-agent text", "thread-sub");
  await until(() => first.runs().get("item-1")?.text === "Hello world", "appended");
  const appended = first.frames.filter((frame) => frame.runId === "item-1");
  assert.ok(
    appended.some((frame) => frame.from > 0),
    "later frames append",
  );
  // A second viewer gets the whole text so far at once.
  const second = connect(t, s.f);
  await until(() => second.runs().get("item-1")?.text === "Hello world", "late viewer");
  assert.equal(second.frames.find((frame) => frame.runId === "item-1").from, 0);
  const live = () => visibleReplies(first.runs(), s.snapshot()).map((run) => run.text);
  assert.deepEqual(live(), ["Hello world"], "the sub-agent thread stays out");
  // The item completes: the run ends and the chat reads its transcript again.
  const before = s.reads();
  s.transcript([{ id: "item-1", role: "assistant", text: "Hello world!" }]);
  notify("item/completed", {
    threadId: "thread-main",
    turnId: "turn-1",
    completedAtMs: Date.now(),
    item: { type: "agentMessage", id: "item-1", text: "Hello world!" },
  });
  await until(
    () => first.frames.some((f) => f.type === "stream-end" && f.runId === "item-1"),
    "stream end",
  );
  await until(() => s.reads() > before, "re-read after the end");
  assert.deepEqual(live(), [], "the final message replaced the live bubble");
  notify("turn/completed", { threadId: "thread-sub", turn: { id: "turn-1" } });
  await until(() => !s.app.chatStreams.replies.runs(sessionId)["item-sub"], "turn end");
});

test("OpenCode streaming part events reach the chat as stream frames", async (t) => {
  const s = await fixture(t, "opencode");
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
      part: () => [{ id: "prt_1", type: "text" }],
    },
  };
  const stop = streamOpenCodeReplies(api, s.channel, () => "ses_1");
  t.after(stop);
  const viewer = connect(t, s.f);
  await until(() => viewer.frames.some((frame) => frame.type === "sync"), "no sync");
  const emit = (type, properties) => handlers.get(type)({ type, properties });
  emit("message.updated", {
    sessionID: "ses_1",
    info: { id: "msg_1", role: "assistant" },
  });
  emit("message.part.updated", {
    sessionID: "ses_1",
    part: { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "" },
  });
  for (const delta of ["Live ", "Open", "Code"])
    emit("message.part.delta", {
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta,
    });
  // Reasoning streams a text field too and stays out.
  emit("message.part.delta", {
    sessionID: "ses_1",
    messageID: "msg_1",
    partID: "prt_reasoning",
    field: "text",
    delta: "thinking",
  });
  // Another session's parts stay out as well.
  emit("message.part.delta", {
    sessionID: "ses_other",
    messageID: "msg_1",
    partID: "prt_1",
    field: "text",
    delta: "!",
  });
  await until(() => viewer.runs().get("prt_1")?.text === "Live OpenCode", "streamed");
  assert.deepEqual([...viewer.runs().keys()], ["prt_1"]);
  emit("message.part.updated", {
    sessionID: "ses_1",
    part: {
      id: "prt_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "Live OpenCode.",
      time: { start: 1, end: 2 },
    },
  });
  await until(
    () => viewer.frames.some((frame) => frame.type === "stream-end"),
    "part end",
  );
  assert.equal(viewer.runs().get("prt_1").text, "Live OpenCode.");
  assert.deepEqual(s.app.chatStreams.replies.runs(sessionId), {});
});

test("a native owner that disconnects ends its streaming runs", async (t) => {
  const s = await fixture(t, "codex");
  s.channel.streamDelta("item-9", "partial", { turn: "turn-9" });
  await until(() => s.app.chatStreams.replies.runs(sessionId)["item-9"], "streaming");
  s.channel.close();
  await until(() => !s.app.chatStreams.replies.runs(sessionId)["item-9"], "ended");
});
