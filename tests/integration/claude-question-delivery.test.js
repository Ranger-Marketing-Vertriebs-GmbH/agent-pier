import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { runClaudeHook } from "../../server/features/requests/claude-hook.js";

const questions = [
  {
    question: "Which layout?",
    options: [
      { label: "Grid", preview: "+--+\n|  |\n+--+" },
      { label: "List", preview: "- a" },
    ],
  },
];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-claude-delivery-"));
  const session = {
    id: "session",
    tool: "claude",
    accountId: "account",
    status: "running",
    nativeRequests: { enabled: true },
  };
  const events = [];
  const broker = new RequestBroker({
    dataDir: root,
    sessions: { get: async () => session },
    onEvent: (event) => events.push(event),
  });
  const launch = await broker.prepare({
    id: session.id,
    account: { id: session.accountId, tool: "claude" },
    cwd: root,
    launch: { command: "claude", args: [], env: {} },
  });
  t.after(async () => {
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { broker, launch, events };
}
function hook(f, { fail = false, event = "PreToolUse" } = {}) {
  let written = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (fail) return callback(Error("Claude closed the hook pipe"));
      written += chunk;
      callback();
    },
  });
  output.on("error", () => {});
  const input = Readable.from([
    JSON.stringify({
      hook_event_name: event,
      tool_name: "AskUserQuestion",
      tool_input: { questions },
    }),
  ]);
  // Bounded so a regression fails the test instead of waiting for the hook timeout.
  const done = runClaudeHook({ input, output, env: f.launch.env, timeout: 4000 });
  return { done, output: () => written };
}
async function waitFor(read, predicate) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Claude delivery observation timed out");
}
const pending = (f) =>
  waitFor(
    async () => (await f.broker.list("session")).requests,
    (requests) => requests.length === 1,
  ).then((requests) => requests[0]);
const within = (promise, ms) => {
  let timer;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

test("a failed hook write releases Claude to its native dialog instead of waiting a day", async (t) => {
  const f = await fixture(t);
  const run = hook(f, { fail: true });
  const ask = await pending(f);
  await assert.rejects(
    f.broker.answer("session", ask.id, {
      expectedRevision: 1,
      answers: { q0: ["Grid"] },
    }),
    { status: 409 },
  );
  assert.equal(await within(run.done, 2000), true, "the hook must exit after failure");
  assert.equal(run.output(), "");
  // The native side withdrew the question, so chat shows no dead entry.
  await waitFor(
    async () => (await f.broker.list("session")).requests,
    (requests) => requests.length === 0,
  );
});

test("an uncertain Claude question can still be handed off to the terminal", async (t) => {
  const f = await fixture(t);
  const run = hook(f);
  const ask = await pending(f);
  // Delivery timed out in the broker although the hook still waits.
  const entry = f.broker.entries.get(ask.id);
  entry.status = "unknown";
  entry.revision = 2;
  await assert.rejects(
    f.broker.answer("session", ask.id, {
      expectedRevision: 2,
      answers: { q0: ["Grid"] },
    }),
    { status: 409 },
  );
  assert.deepEqual(await f.broker.handoff("session", ask.id, { expectedRevision: 2 }), {
    requests: [],
  });
  assert.equal(await within(run.done, 2000), true);
  assert.equal(run.output(), "", "handoff leaves the decision to Claude's own dialog");
  assert.equal(f.events.at(-1).action, "request.handed-off");
});

test("touching a dialog is visible to other clients without changing its revision", async (t) => {
  const f = await fixture(t);
  const run = hook(f);
  const ask = await pending(f);
  assert.equal(ask.interaction, undefined);
  await f.broker.touch("session", ask.id, { client: "phone-tab" });
  const [touched] = (await f.broker.list("session")).requests;
  assert.equal(touched.revision, 1);
  assert.equal(touched.interaction.client, "phone-tab");
  assert.ok(touched.interaction.age >= 0 && touched.interaction.age < 5000);
  for (const client of [undefined, "", "x".repeat(101), "bad client"])
    await assert.rejects(f.broker.touch("session", ask.id, { client }), {
      status: 400,
    });
  await assert.rejects(f.broker.touch("session", "missing", { client: "a" }), {
    status: 409,
  });
  await f.broker.handoff("session", ask.id, { expectedRevision: 1 });
  await run.done;
});
