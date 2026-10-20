import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  NativeSessionBinding,
  MESSAGE_DISPLAY_VERSION,
  hookPush,
  runNativeSessionHook,
} from "../../server/features/sessions/native-session-binding.js";
import {
  MINIMUM_CLI_VERSIONS,
  atLeast,
} from "../../server/features/tools/cli-version.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { ReplyStreams } from "../../server/features/chat/reply-streams.js";
import { ClaudeDisplayDrafts } from "../../server/features/chat/claude-display-drafts.js";
import { nextReplies, visibleReplies } from "../../web/features/chat/reply-stream.js";
import { until } from "../helpers/adapter-process.js";

const TURN = "0c9e6a2f-7d41-4f4e-9a15-3f4f7c2b8d10";
const FIRST = "5b2a9c8e-1f63-4d8a-b7c4-9e0d2a6f1c3b";
const SECOND = "6c3b0d9f-2a74-4e9b-c8d5-0f1e3b7a2d4c";

function drafts(t) {
  const frames = [];
  const ended = [];
  const replies = new ReplyStreams({ flushMs: 1, onEnd: (id) => ended.push(id) });
  t.after(() => replies.close());
  replies.subscribe("s", (frame) => frames.push(frame));
  const streams = {
    streamText: (...args) => replies.streamText(...args),
    endStream: (...args) => replies.endStream(...args),
  };
  // The browser's fold of everything sent so far.
  const runs = () =>
    frames.reduce((value, frame) => nextReplies(value, frame), new Map());
  return { drafts: new ClaudeDisplayDrafts({ streams }), replies, frames, ended, runs };
}
const batch = (index, delta, extra = {}) => ({
  turnId: TURN,
  messageId: FIRST,
  index,
  final: false,
  delta,
  ...extra,
});
const settle = () => delay(10);

test("MessageDisplay batches are shown in index order, also when they arrive out of order", async (t) => {
  const d = drafts(t);
  d.drafts.display("s", batch(1, "second line\n"));
  await settle();
  assert.equal(d.runs().size, 0, "waits for batch 0");
  d.drafts.display("s", batch(0, "first line\n"));
  d.drafts.display("s", batch(0, "duplicate\n"));
  d.drafts.display("s", batch(2, "", { final: true }));
  await settle();
  const run = d.runs().get(`claude-${FIRST}`);
  assert.equal(run.text, "first line\nsecond line\n");
  assert.equal(run.turn, TURN);
  assert.equal(run.order, 0);
});

test("a final batch may end mid-line", async (t) => {
  const d = drafts(t);
  d.drafts.display("s", batch(0, "Done:\n"));
  d.drafts.display("s", batch(1, "all good", { final: true }));
  await settle();
  assert.equal(d.runs().get(`claude-${FIRST}`).text, "Done:\nall good");
});

test("several messages in one turn keep their order and give way to the JSONL one by one", async (t) => {
  const d = drafts(t);
  d.drafts.display("s", batch(0, "Let me check.\n", { final: true }));
  d.drafts.display("s", { ...batch(0, "Found it:\n"), messageId: SECOND });
  await settle();
  const user = { id: "u", role: "user", text: "Fix it" };
  const tool = { id: "tool", role: "tool", text: "ls" };
  const shown = (...rows) =>
    visibleReplies(d.runs(), { messages: [user, ...rows] }).map((run) => run.text);
  assert.deepEqual(shown(), ["Let me check.\n", "Found it:\n"]);
  // The transcript writes the first message (its own id, slightly different text).
  const first = { id: "msg_01:0", role: "assistant", text: "Let me check." };
  assert.deepEqual(shown(first, tool), ["Found it:\n"]);
  const second = { id: "msg_02:0", role: "assistant", text: "Found it: the bug." };
  assert.deepEqual(shown(first, tool, second), []);
});

test("Stop replaces the last draft with the whole reply, then the turn ends", async (t) => {
  const d = drafts(t);
  d.drafts.display("s", batch(0, "Partial\n"));
  await settle();
  d.drafts.stop("s", "Partial\nand the rest.");
  await settle();
  const runs = d.runs();
  assert.equal(runs.get(`claude-${FIRST}`).text, "Partial\nand the rest.");
  assert.equal(runs.get(`claude-${FIRST}`).ended, true);
  assert.deepEqual(d.replies.runs("s"), {});
  assert.deepEqual(d.ended, ["s"], "the chat reads its transcript again");
});

test("a new turn or an interrupt drops the last turn's drafts", async (t) => {
  const d = drafts(t);
  d.drafts.display("s", batch(0, "Interrupted\n"));
  d.drafts.display("s", { ...batch(0, "Next turn\n"), turnId: "other-turn" });
  await settle();
  assert.deepEqual(
    Object.values(d.replies.runs("s")).map((run) => run.text),
    ["Next turn\n"],
  );
  d.drafts.end("s");
  assert.deepEqual(d.replies.runs("s"), {});
});

test("a turn's drafts are capped", async (t) => {
  const frames = [];
  const replies = new ReplyStreams({ flushMs: 1 });
  t.after(() => replies.close());
  replies.subscribe("s", (frame) => frames.push(frame));
  const capped = new ClaudeDisplayDrafts({
    streams: { streamText: (...a) => replies.streamText(...a), endStream() {} },
    maxTurnText: 8,
  });
  capped.display("s", batch(0, "12345\n"));
  capped.display("s", { ...batch(0, "abcdef\n"), messageId: SECOND });
  assert.deepEqual(
    Object.values(replies.runs("s")).map((run) => run.text),
    ["12345\n", "ab"],
  );
});

test("hook payloads map to pushes; sub-agent text stays out", () => {
  const payload = {
    hook_event_name: "MessageDisplay",
    turn_id: TURN,
    message_id: FIRST,
    index: 3,
    final: true,
    delta: "",
  };
  assert.deepEqual(hookPush(payload), {
    type: "claude-display",
    turnId: TURN,
    messageId: FIRST,
    index: 3,
    final: true,
    delta: "",
  });
  assert.equal(hookPush({ ...payload, agent_id: "agent-1" }), null);
  assert.deepEqual(hookPush({ hook_event_name: "Stop", last_assistant_message: "Bye" }), {
    type: "activity",
    event: "Stop",
    lastAssistantMessage: "Bye",
  });
  assert.deepEqual(
    hookPush({ hook_event_name: "Stop", agent_id: "a", last_assistant_message: "x" }),
    { type: "activity", event: "Stop" },
  );
});

test("the MessageDisplay hook is installed only for a Claude Code that has it", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "display-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
  const bindings = new NativeSessionBinding({ dataDir: accounts.dataDir, accounts });
  const stream = async (id, cliVersion) => {
    const account = accounts.create({ name: id, tool: "claude" });
    const prepared = await bindings.prepare({
      id,
      account,
      cwd,
      launch: { command: process.execPath, args: [], env: {}, cliVersion },
    });
    const dir = prepared.args.find((arg) => arg.endsWith(`${id}.claude-stream`));
    return dir && JSON.parse(fs.readFileSync(path.join(dir, "hooks/hooks.json"), "utf8"));
  };
  const hooks = await stream("current", "2.1.304");
  assert.equal(
    hooks.hooks.MessageDisplay[0].hooks[0].async,
    true,
    "never blocks the TUI",
  );
  assert.match(hooks.hooks.MessageDisplay[0].hooks[0].command, /--record/);
  assert.equal(await stream("old", "2.1.151"), undefined);
  assert.equal(await stream("unknown", undefined), undefined);
  assert.ok(
    atLeast(MINIMUM_CLI_VERSIONS.claude, MESSAGE_DISPLAY_VERSION),
    "every managed Claude Code AgentPier starts has the event",
  );
  await bindings.discard("current");
  assert.equal(
    fs.existsSync(path.join(bindings.directory, "current.claude-stream")),
    false,
  );
});

test("hook processes stream a Claude reply through the broker, in order, never blocking", async (t) => {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "display-push-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session = {
    id: "s",
    accountId: "account",
    tool: "claude",
    status: "running",
    nativeRequests: { enabled: true },
  };
  const d = drafts(t);
  const broker = new RequestBroker({
    dataDir,
    sessions: { get: async () => ({ ...session }) },
    onNative: (id, push) => {
      if (push.type === "claude-display") d.drafts.display(id, push);
      if (push.event === "Stop") d.drafts.stop(id, push.lastAssistantMessage);
    },
  });
  t.after(() => broker.close());
  const launch = await broker.prepare({
    id: "s",
    account: { id: "account", tool: "claude" },
    cwd: dataDir,
    launch: { command: "/fixture/claude", args: [], env: {} },
  });
  const stderr = process.stderr.write;
  process.stderr.write = () => true;
  t.after(() => (process.stderr.write = stderr));
  const hook = (payload) =>
    runNativeSessionHook({
      env: launch.env,
      input: Readable.from([JSON.stringify(payload)]),
    });
  const display = (index, delta, final = false) =>
    hook({
      hook_event_name: "MessageDisplay",
      turn_id: TURN,
      message_id: FIRST,
      index,
      final,
      delta,
    });
  // Asynchronous hook processes finish in any order.
  await Promise.all([
    display(2, "three", true),
    display(1, "two\n"),
    display(0, "one\n"),
  ]);
  await until(() => d.runs().get(`claude-${FIRST}`)?.text === "one\ntwo\nthree", 2000);
  await hook({ hook_event_name: "Stop", last_assistant_message: "one\ntwo\nthree." });
  await until(() => d.runs().get(`claude-${FIRST}`)?.ended, 2000);
  assert.equal(d.runs().get(`claude-${FIRST}`).text, "one\ntwo\nthree.");
  // With the server down the hook still returns at once.
  await broker.close();
  const start = Date.now();
  await display(3, "late\n");
  assert.ok(Date.now() - start < 1600);
});
