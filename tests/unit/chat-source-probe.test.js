import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { probeChatSources } from "../../server/features/chat/chat-source-probe.js";
import { ChatStore } from "../../server/features/chat/chat-store.js";
import { ChatStreams } from "../../server/features/chat/chat-streams.js";
import { ChatEvents } from "../../server/features/chat/chat-events.js";
import { until } from "../helpers/adapter-process.js";

function fakeProbe(t, files, state) {
  const reports = [];
  const stop = probeChatSources({
    sources: () => state,
    changed: () => reports.push(Date.now()),
    intervalMs: 10,
    stat: async (file) => {
      if (!files.has(file)) throw Object.assign(Error("missing"), { code: "ENOENT" });
      return files.get(file);
    },
  });
  t.after(stop);
  return { reports, stop };
}

test("the probe reports a change the last read cannot have seen", async (t) => {
  const files = new Map([["/t.jsonl", { size: 10, mtimeMs: 100 }]]);
  const state = { paths: ["/t.jsonl"], readAt: 200 };
  const { reports } = fakeProbe(t, files, state);
  await delay(50);
  assert.equal(reports.length, 0, "unchanged since the read");
  files.set("/t.jsonl", { size: 20, mtimeMs: 300 });
  await until(() => reports.length === 1, 2000);
  await delay(50);
  assert.equal(reports.length, 1, "one report per change");
});

test("a change a watcher or push already caused a read for is not reported again", async (t) => {
  const files = new Map([["/t.jsonl", { size: 10, mtimeMs: 100 }]]);
  const state = { paths: ["/t.jsonl"], readAt: 200 };
  const { reports } = fakeProbe(t, files, state);
  await delay(30);
  // The watcher fired first: its read started after the write.
  files.set("/t.jsonl", { size: 20, mtimeMs: 300 });
  state.readAt = 310;
  await delay(60);
  assert.equal(reports.length, 0);
});

test("a write during the read is reported once, then settles", async (t) => {
  const files = new Map([["/db", { size: 1, mtimeMs: 250 }]]);
  const state = { paths: ["/db", "/db-wal"], readAt: 200 };
  const { reports } = fakeProbe(t, files, state);
  await until(() => reports.length === 1, 2000);
  state.readAt = 400;
  files.set("/db-wal", { size: 5, mtimeMs: 300 });
  await delay(60);
  assert.equal(reports.length, 1, "the WAL appeared before the next read started");
  files.set("/db-wal", { size: 9, mtimeMs: 500 });
  await until(() => reports.length === 2, 2000);
});

test("the probe stops for good", async (t) => {
  const files = new Map([["/t", { size: 1, mtimeMs: 1 }]]);
  const state = { paths: ["/t"], readAt: 0 };
  const { reports, stop } = fakeProbe(t, files, state);
  await until(() => reports.length === 1, 2000);
  stop();
  files.set("/t", { size: 2, mtimeMs: 2 });
  await delay(60);
  assert.equal(reports.length, 1);
});

test("replacement and deletion are noticed even with preserved modification time", async (t) => {
  const files = new Map([
    ["/t", { dev: 1, ino: 1, size: 10, mtimeMs: 100, ctimeMs: 100 }],
  ]);
  const state = { paths: ["/t"], readAt: 200 };
  const { reports } = fakeProbe(t, files, state);
  await delay(40);
  assert.equal(reports.length, 0);
  files.set("/t", { dev: 1, ino: 2, size: 10, mtimeMs: 100, ctimeMs: 100 });
  await until(() => reports.length === 1, 1000);
  files.delete("/t");
  await until(() => reports.length === 2, 1000);
  await delay(40);
  assert.equal(reports.length, 2, "missing is reported only once");
  files.set("/t", { dev: 1, ino: 3, size: 10, mtimeMs: 100, ctimeMs: 100 });
  await until(() => reports.length === 3, 1000);
});

test("a viewed chat sees an appended transcript although no watcher fires", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, "t.jsonl");
  fs.writeFileSync(transcript, "a\n");
  const session = {
    id: "s1",
    accountId: "a",
    tool: "claude",
    cwd: "/x",
    status: "running",
  };
  const events = new ChatEvents();
  let reads = 0;
  const chat = new ChatStore({
    dataDir: dir,
    sessions: { get: async () => ({ ...session }) },
    history: {
      list: async () => [],
      readPage: async () => {
        reads++;
        const lines = fs.readFileSync(transcript, "utf8").trim().split("\n");
        return {
          messages: [{ id: `m${lines.length}`, role: "assistant", text: "x" }],
          tasks: [],
          sources: [transcript],
        };
      },
    },
    events,
  });
  chat.initialize(session, "11111111-1111-1111-1111-111111111111", "manual");
  const stops = [];
  const streams = new ChatStreams({
    sessions: { get: async () => ({ ...session }) },
    chat,
    chatImages: { read: (id) => chat.read(id) },
    chatEvents: events,
    accounts: {},
    config: {},
    watch: () => () => {},
    watchInput: () => () => {},
    debounceMs: 5,
    probeMs: 50,
    probe: (options) => {
      const stop = probeChatSources(options);
      stops.push(stop);
      return () => {
        stops.length = 0;
        stop();
      };
    },
  });
  t.after(() => streams.close());
  const values = [];
  const unsubscribe = streams.subscribe("s1", (value) => values.push(value));
  await until(() => values.at(-1)?.snapshot?.messages[0]?.id === "m1", 10_000);
  assert.deepEqual(chat.sourceState("s1").paths, [transcript]);
  assert.equal("sources" in values.at(-1).snapshot, false, "paths stay on the server");
  await delay(120);
  const settled = reads;
  await delay(200);
  assert.equal(reads, settled, "no change, no read");
  fs.appendFileSync(transcript, "b\n");
  await until(() => values.at(-1)?.snapshot?.messages[0]?.id === "m2", 2000);
  unsubscribe();
  assert.equal(stops.length, 0, "the last viewer stopped the probe");
});
