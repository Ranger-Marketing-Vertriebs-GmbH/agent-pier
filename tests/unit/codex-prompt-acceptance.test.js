import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { codexPromptAcceptance } from "../../server/features/requests/codex-prompt-acceptance.js";

const fixtures = new URL("../fixtures/codex-prompt-acceptance/", import.meta.url);

/** The JSON-RPC messages of a recorded run, in order (the first line is a note). */
function recorded(name) {
  return fs
    .readFileSync(new URL(`${name}.jsonl`, fixtures), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => row.m);
}

function replay(rows) {
  const events = [];
  const tracker = codexPromptAcceptance((event) => events.push(event));
  for (const { dir, m } of rows)
    if (dir === "out") tracker.outgoing(m);
    else tracker.incoming(m);
  return events;
}

function shape(events) {
  return events.map(({ at, ...event }) => {
    assert.equal(typeof at, "number");
    return event;
  });
}

const accepted = (imageCount) => ({ kind: "accepted", imageNames: null, imageCount });

for (const [name, expected] of [
  ["text", [accepted(0)]],
  ["multi-line", [accepted(0)]],
  ["image", [accepted(2)]],
  ["image-file", [accepted(1)]],
  ["steer", [accepted(0), accepted(0)]],
])
  test(`Codex prompt acceptance: ${name} prompts are accepted once`, () => {
    assert.deepEqual(shape(replay(recorded(name))), expected);
  });

test("Codex prompt acceptance: the title-generation turn is ignored", () => {
  const rows = recorded("text");
  const title = rows.filter(
    ({ m }) =>
      m.params?.clientUserMessageId === null ||
      m.params?.item?.clientId === null ||
      String(m.id).startsWith("temporary-"),
  );
  assert.equal(title.length, 3, "the run holds a title turn without a client id");
  assert.deepEqual(replay(title), []);
});

test("Codex prompt acceptance: a hook-blocked turn/start is dropped with the reason", () => {
  assert.deepEqual(shape(replay(recorded("blocked-start"))), [
    { kind: "dropped", imageNames: null, imageCount: 0, reason: "spike blocked" },
  ]);
});

test("Codex prompt acceptance: a hook-blocked turn/steer reports nothing", () => {
  // The running start is accepted; the blocked steer gives no reliable drop signal.
  assert.deepEqual(shape(replay(recorded("blocked-steer"))), [accepted(0)]);
});

test("Codex prompt acceptance: a userMessage on another thread does not match", () => {
  const rows = recorded("text").map((row) =>
    row.m.method === "item/started"
      ? { ...row, m: { ...row.m, params: { ...row.m.params, threadId: "other" } } }
      : row,
  );
  assert.deepEqual(replay(rows), []);
});

test("Codex prompt acceptance: unknown shapes are ignored without throwing", () => {
  const events = [];
  const tracker = codexPromptAcceptance((event) => events.push(event));
  for (const message of [
    null,
    undefined,
    "text",
    42,
    {},
    { method: "turn/start" },
    { method: "turn/start", params: null },
    { id: 1, method: "turn/start", params: { clientUserMessageId: "c", input: "x" } },
    { id: 2, method: "turn/steer", params: { clientUserMessageId: 7, input: [] } },
    { id: 3, method: "turn/start", params: { clientUserMessageId: "d", input: [null] } },
  ])
    tracker.outgoing(message);
  for (const message of [
    null,
    "text",
    {},
    { id: 1 },
    { id: 1, result: null },
    { id: 3, result: { turn: "x" } },
    { method: "item/started" },
    { method: "item/started", params: { item: null } },
    { method: "item/started", params: { item: { type: "userMessage" } } },
    { method: "hook/completed", params: { run: null } },
    { method: "hook/completed", params: { turnId: "t", run: { status: "blocked" } } },
    { method: "turn/completed", params: {} },
    { method: "turn/completed", params: { turn: null } },
  ])
    tracker.incoming(message);
  assert.deepEqual(events, []);
});

test("Codex prompt acceptance: a matched prompt is reported once", () => {
  const rows = recorded("text");
  const userMessage = rows.find(
    ({ m }) => m.method === "item/started" && m.params.item.clientId,
  );
  assert.equal(replay([...rows, userMessage]).length, 1);
});

test("Codex prompt acceptance remembers at most 64 prompts", () => {
  const events = [];
  const tracker = codexPromptAcceptance((event) => events.push(event));
  const start = (n) => ({
    id: n,
    method: "turn/start",
    params: { threadId: "t", clientUserMessageId: `c${n}`, input: [] },
  });
  const userMessage = (n) => ({
    method: "item/started",
    params: {
      threadId: "t",
      turnId: "x",
      item: { type: "userMessage", clientId: `c${n}` },
    },
  });
  for (let n = 0; n < 65; n += 1) tracker.outgoing(start(n));
  tracker.incoming(userMessage(0));
  assert.equal(events.length, 0, "the oldest prompt was forgotten");
  tracker.incoming(userMessage(1));
  tracker.incoming(userMessage(64));
  assert.equal(events.length, 2);
});
