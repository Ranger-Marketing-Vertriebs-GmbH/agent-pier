import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";

async function fixture(t, tool = "claude") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-requests-"));
  const session = {
    id: "fixture",
    tool,
    accountId: "account",
    status: "running",
    nativeRequests: { enabled: true },
  };
  const events = [];
  const broker = new RequestBroker({
    dataDir: root,
    sessions: {
      get: async (id) => {
        assert.equal(id, session.id);
        return session;
      },
    },
    onEvent: (e) => events.push(e),
  });
  const launch = await broker.prepare({
    id: session.id,
    account: { id: "account", tool },
    cwd: root,
    launch: { command: "/fixture/cli", args: [], env: {} },
  });
  const channel = new NativeRequestChannel({ env: launch.env });
  t.after(async () => {
    channel.close();
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await channel.ready;
  return { broker, channel, session, events };
}
const request = {
  kind: "permission",
  options: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ],
  subject: { command: "fixture command" },
};
async function waitFor(read, predicate = (value) => value.requests?.length) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Timed out waiting for native request");
}

test("native answers are claimed once even when browser submissions race", async (t) => {
  const { broker, channel, events } = await fixture(t);
  const delivered = [];
  channel.publish("native-1", request, async (answer) => {
    delivered.push(answer);
  });
  const {
    requests: [ask],
  } = await waitFor(() => broker.list("fixture"));
  const results = await Promise.allSettled([
    broker.answer("fixture", ask.id, { expectedRevision: 1, choice: "allow" }),
    broker.answer("fixture", ask.id, { expectedRevision: 1, choice: "allow" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.deepEqual(delivered, [{ choice: "allow" }]);
  assert.equal((await broker.list("fixture")).requests.length, 0);
  assert.equal(JSON.stringify(events).includes("fixture command"), false);
  assert.equal(events.at(-1).resourceId, ask.id);
  assert.equal(JSON.stringify(events).includes("native-1"), false);
});

test("Terminal resolution invalidates the old occurrence even for identical repeated prompts", async (t) => {
  const { broker, channel } = await fixture(t, "codex");
  let calls = 0;
  channel.publish("native-1", request, async () => calls++);
  const old = (await waitFor(() => broker.list("fixture"))).requests[0];
  channel.resolve("native-1");
  channel.publish("native-2", request, async () => calls++);
  const next = (
    await waitFor(
      () => broker.list("fixture"),
      (r) => r.requests.length === 1 && r.requests[0].id !== old.id,
    )
  ).requests[0];
  await assert.rejects(
    broker.answer("fixture", old.id, { expectedRevision: 1, choice: "allow" }),
    { status: 409 },
  );
  assert.notEqual(old.id, next.id);
  assert.equal(calls, 0);
});

test("complete ordered questions validate selections and preserve free text", async (t) => {
  const { broker, channel } = await fixture(t, "opencode");
  let answer;
  channel.publish(
    "question",
    {
      kind: "question",
      questions: [
        {
          id: "q1",
          prompt: "Framework?",
          options: [{ id: "React", label: "React" }],
          multiple: false,
          allowOther: false,
        },
        {
          id: "q2",
          prompt: "Checks?",
          options: [
            { id: "unit", label: "Unit" },
            { id: "browser", label: "Browser" },
          ],
          multiple: true,
          allowOther: false,
        },
        { id: "q3", prompt: "Notes?", options: [], multiple: false, allowOther: true },
      ],
    },
    async (value) => {
      answer = value;
    },
  );
  const ask = (await waitFor(() => broker.list("fixture"))).requests[0];
  for (const answers of [{ q1: ["React"] }, { q1: ["bad"], q2: ["unit"], q3: ["fine"] }])
    await assert.rejects(
      broker.answer("fixture", ask.id, { expectedRevision: 1, answers }),
      { status: 400 },
    );
  const answers = { q1: ["React"], q2: ["unit", "browser"], q3: ["Unicode ✓"] };
  await broker.answer("fixture", ask.id, { expectedRevision: 1, answers });
  assert.deepEqual(answer, { answers });
});

test("disconnect and wrong revisions cannot send a native answer", async (t) => {
  const { broker, channel } = await fixture(t);
  channel.publish("native-1", request, async () => assert.fail("must not deliver"));
  const ask = (await waitFor(() => broker.list("fixture"))).requests[0];
  await assert.rejects(
    broker.answer("fixture", ask.id, { expectedRevision: 99, choice: "allow" }),
    { status: 409 },
  );
  channel.close();
  await waitFor(
    () => broker.list("fixture"),
    (r) => r.requests.length === 0,
  );
  await assert.rejects(
    broker.answer("fixture", ask.id, { expectedRevision: 1, choice: "allow" }),
    { status: 409 },
  );
});

test("handoff releases the native hook without synthesizing consent", async (t) => {
  const { broker, channel } = await fixture(t);
  let result;
  channel.publish("native-1", request, async (value) => {
    result = value;
  });
  const ask = (await waitFor(() => broker.list("fixture"))).requests[0];
  await broker.handoff("fixture", ask.id, { expectedRevision: 1 });
  assert.deepEqual(result, { handoff: true });
});

test("a helper-owned pending request survives broker restart without duplicate created events", async (t) => {
  const { broker, channel, session, events } = await fixture(t);
  channel.publish("restart-pending", request, async () => {});
  const old = (await waitFor(() => broker.list("fixture"))).requests[0];
  await broker.close();
  const restarted = new RequestBroker({
    dataDir: path.dirname(broker.directory),
    sessions: { get: async () => session },
    onEvent: (e) => events.push(e),
  });
  t.after(() => restarted.close());
  await restarted.ready;
  const current = (await waitFor(() => restarted.list("fixture"))).requests[0];
  assert.equal(current.id, old.id);
  assert.equal(events.filter((e) => e.action === "request.created").length, 1);
  await restarted.answer("fixture", current.id, { expectedRevision: 1, choice: "deny" });
});
