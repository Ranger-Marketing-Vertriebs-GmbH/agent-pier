import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ChatStore } from "../../server/features/chat/chat-store.js";
import { ChatStreams } from "../../server/features/chat/chat-streams.js";
import { ChatEvents } from "../../server/features/chat/chat-events.js";
import { until } from "../helpers/adapter-process.js";

function fixture(t, { waiting = false, tool = "claude", extra = [], watch } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-source-files-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  for (const name of ["sessions", "native-sessions", "profile", "transcripts"])
    fs.mkdirSync(path.join(dataDir, name));
  const file = path.join(dataDir, "transcripts", "native-one.jsonl");
  fs.writeFileSync(file, "first");
  const session = { id: "s1", accountId: "a", tool, cwd: dataDir, status: "running" };
  const source = { file, waiting, reads: 0 };
  const events = new ChatEvents();
  const chat = new ChatStore({
    dataDir,
    sessions: { get: async () => ({ ...session }) },
    events,
    history: {
      list: async () => [],
      readPage: async () => {
        source.reads++;
        if (source.waiting) throw Object.assign(Error("not created"), { status: 404 });
        return {
          messages: [
            {
              id: "m",
              role: "assistant",
              text:
                fs.readFileSync(source.file, "utf8") +
                extra
                  .map((name) =>
                    fs.existsSync(name) ? fs.readFileSync(name, "utf8") : "",
                  )
                  .join(""),
            },
          ],
          tasks: [],
          sources: [source.file, ...extra],
        };
      },
    },
  });
  chat.initialize(session, "native-one", "manual");
  const streams = new ChatStreams({
    sessions: { get: async () => ({ ...session }) },
    chat,
    chatImages: { read: (id) => chat.read(id) },
    chatEvents: events,
    accounts: {
      environment: () => ({
        HOME: dataDir,
        CLAUDE_CONFIG_DIR: path.join(dataDir, "profile"),
      }),
    },
    config: { dataDir, home: dataDir },
    debounceMs: 5,
    settleMs: 20,
    probeMs: 25,
    recoveryMs: 60000,
    watchInput: () => () => {},
  });
  if (watch) streams.sourceWatches.watch = watch;
  t.after(() => streams.close());
  const values = [];
  const stop = streams.subscribe("s1", (value) => values.push(value));
  const text = () => values.at(-1)?.snapshot?.messages[0]?.text;
  const idle = () =>
    !streams.entries.get("s1")?.pending && !streams.entries.get("s1")?.timer;
  return { dataDir, file, source, session, chat, streams, values, stop, text, idle };
}

test("real file append, atomic replacement and recreation reach an open chat", async (t) => {
  const f = fixture(t);
  await until(() => f.text() === "first" && f.idle());
  fs.appendFileSync(f.file, " append");
  await until(() => f.text() === "first append");
  const replacement = path.join(f.dataDir, "replacement");
  fs.writeFileSync(replacement, "replacement");
  fs.utimesSync(replacement, new Date(0), new Date(0));
  fs.renameSync(replacement, f.file);
  await until(() => f.text() === "replacement");
  fs.unlinkSync(f.file);
  await delay(80);
  fs.writeFileSync(f.file, "recreated");
  fs.utimesSync(f.file, new Date(0), new Date(0));
  await until(() => f.text() === "recreated");
  f.stop();
  assert.equal(f.streams.sourceWatches.entries.size, 0);
});

test("a transcript created after a waiting snapshot is found without a directory event", async (t) => {
  const f = fixture(t, { waiting: true });
  await until(() => f.values.at(-1)?.snapshot?.availability === "waiting");
  f.source.waiting = false;
  // No watched file or directory is changed. The discovery safety net must re-read.
  await until(() => f.text() === "first", 3000);
  assert.ok(f.streams.sourceWatches.entries.size > 0);
});

test("account rebinding retires the previous source and cannot revive it", async (t) => {
  const f = fixture(t);
  await until(() => f.text() === "first" && f.idle());
  const other = path.join(f.dataDir, "transcripts", "native-two.jsonl");
  fs.writeFileSync(other, "other account");
  f.source.file = other;
  f.session.accountId = "b";
  assert.equal(f.chat.sourceState("s1", f.session), null, "old scope is never reused");
  f.chat.initialize(f.session, "native-two", "manual");
  await until(() => f.text() === "other account" && f.idle());
  assert.ok(
    ![...f.streams.sourceWatches.entries.values()].some((e) => e.file === f.file),
  );
  await delay(80);
  await until(f.idle);
  const reads = f.source.reads;
  fs.appendFileSync(f.file, " foreign change");
  await delay(150);
  assert.equal(f.source.reads, reads, "old account no longer invalidates the chat");
  assert.equal(f.text(), "other account");
  f.chat.reset("s1");
  assert.equal(f.chat.sourceState("s1"), null, "binding reset clears all source paths");
});

test("only a child source changing updates the parent chat before recovery", async (t) => {
  const childDir = fs.mkdtempSync(path.join(os.tmpdir(), "child-source-"));
  t.after(() => fs.rmSync(childDir, { recursive: true, force: true }));
  const child = path.join(childDir, "child.jsonl");
  fs.writeFileSync(child, " child-one");
  const f = fixture(t, { tool: "codex", extra: [child] });
  await until(() => f.text() === "first child-one");
  fs.writeFileSync(child, " child-two");
  await until(() => f.text() === "first child-two", 3000);
  assert.equal("sources" in f.values.at(-1).snapshot, false);
});

test("Claude subagent-only events still invalidate their parent's history", async (t) => {
  const registrations = [];
  // Inject the OS event boundary: FSEvents can delay notifications indefinitely
  // on a busy host. Real-file/probe recovery is exercised independently above.
  const f = fixture(t, {
    watch: (file, options, listener) => {
      const watcher = new EventEmitter();
      watcher.unref = watcher.close = () => {};
      registrations.push({ file, options, listener });
      return watcher;
    },
  });
  const subagents = path.join(path.dirname(f.file), "native-one", "subagents");
  fs.mkdirSync(subagents, { recursive: true });
  const child = path.join(subagents, "agent-child.jsonl");
  fs.writeFileSync(child, "one");
  await until(() => f.text() === "first" && f.idle());
  await delay(80);
  await until(f.idle);
  const target = registrations.find((entry) => entry.file === subagents);
  assert.ok(target, "the session's subagent directory is observed");
  assert.equal(target.options.recursive, true);
  const before = f.source.reads;
  fs.appendFileSync(child, "two");
  target.listener("change", path.basename(child));
  await until(() => f.source.reads > before);
});
