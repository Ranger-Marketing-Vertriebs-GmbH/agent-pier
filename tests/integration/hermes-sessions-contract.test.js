import test from "node:test";
import assert from "node:assert/strict";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import {
  collectEvents,
  endsRun,
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";
import { ChatStreams } from "../../server/features/assistants/chat-stream.js";
import { RunSteps } from "../../server/features/assistants/run-steps.js";
import { publicMessages } from "../../server/features/assistants/conversations.js";

// The Hermes adapter's sessions and run events against the pinned Hermes as AgentPier
// runs it: the supervised messaging gateway and the RPC bridge to its session store
// (hermes-native.js), with the in-repo fake model and a private HOME and HERMES_HOME.
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-agent";
const label = "AgentPier hermes-agent chat";

// The Hermes runtime of the agent, started over the fake model.
const hermes = (t, { dirs, model }) => startHermes(t, dirs, { agentId, model });

async function sandbox(t) {
  const model = await startFakeModel({ slowMs: 300 });
  t.after(() => model.close());
  const dirs = hermesSandbox(t);
  return { dirs, model };
}

test(
  "Hermes contract: a session is created, streams a turn and is deleted",
  options,
  async (t) => {
    const box = await sandbox(t);
    const { dirs } = box;
    const { sessions, events, stop } = await hermes(t, box);
    const { key } = await sessions.create({ agentId, label, idempotencyKey: "create-1" });
    assert.match(key, /^agent:hermes-agent:hermes:\S+$/);
    // The same idempotency key names the same session.
    assert.deepEqual(
      await sessions.create({ agentId, label, idempotencyKey: "create-1" }),
      { key },
    );
    assert.deepEqual(
      (await sessions.list({ agentId, label })).map((s) => s.key),
      [key],
    );
    assert.equal((await sessions.describe({ key })).session.label, label);
    const run = collectEvents(events);
    const sent = await sessions.send({
      key,
      turn: { message: "hello hermes" },
      idempotencyKey: "run-1",
    });
    assert.equal(sent.runId, "run-1");
    const end = await run.until(endsRun("run-1"));
    assert.equal(end.kind, "finished");
    const own = run.seen.filter((e) => e.runId === "run-1");
    assert.equal(own[0].kind, "started");
    // The streamed deltas add up to the reply.
    const text = own
      .filter((e) => e.kind === "text")
      .map((e) => e.payload.text)
      .join("");
    assert.equal(text.trim(), end.payload.text.trim());
    // No onboarding hint was appended to the first message (onboarding off).
    assert.equal(end.payload.text, "ECHO: hello hermes");
    // The normalized reply holds the whole text so far from the first delta on, and
    // the chat's stream follows it (agent-runtime.js `reply`, chat-stream.js).
    const streams = new ChatStreams();
    const streamed = own
      .filter((e) => e.kind === "text" && e.reply)
      .map((e) => [e.reply.text, streams.delta(e)]);
    assert.ok(streamed.length > 0);
    assert.ok(streamed.every(([whole, shown]) => whole === shown));
    assert.equal(streamed.at(-1)[0].trim(), end.payload.text.trim());
    assert.deepEqual(end.reply, {
      text: end.payload.text,
      delta: undefined,
      replace: false,
    });
    // The run's steps: its start, then writing.
    assert.deepEqual(own[0].step, { type: "lifecycle", phase: "start" });
    const steps = new RunSteps();
    const phases = own.map((e) => (steps.observe(e), steps.view("run-1")?.phase));
    assert.ok(phases.includes("writing"), phases.join());
    assert.ok(own.every((e) => e.sessionKey === key && e.reason === null));
    assert.equal((await sessions.wait({ runId: "run-1", waitMs: 1 })).status, "ok");
    const history = await sessions.history({ sessionKey: key, limit: 10 });
    assert.deepEqual(
      history.messages.map((m) => [m.role, m.text]),
      [
        ["user", "hello hermes"],
        ["assistant", end.payload.text],
      ],
    );
    // Each row's entry: a unique id, its text, a timestamp in milliseconds.
    const entries = history.messages.map((m) => m.entry);
    assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
    assert.deepEqual(
      entries.map((e) => [e.role, e.text, e.internal, e.compaction]),
      [
        ["user", "hello hermes", false, null],
        ["assistant", end.payload.text, false, null],
      ],
    );
    for (const entry of entries) {
      assert.equal(typeof entry.id, "string");
      assert.ok(Math.abs(entry.timestamp - Date.now()) < 600000, String(entry.timestamp));
    }
    assert.deepEqual(
      publicMessages(history.messages).map((m) => [m.role, m.text]),
      [
        ["user", "hello hermes"],
        ["assistant", end.payload.text],
      ],
    );
    // Hermes's own title never replaces the label AgentPier finds its chat by.
    assert.deepEqual(
      (await sessions.list({ agentId, label })).map((s) => s.key),
      [key],
    );
    const { title } = await sessions.title({
      agentId,
      message: "the budget",
      reply: "10k",
    });
    assert.equal(typeof title, "string");
    assert.ok(title.length > 0);
    await sessions.compact({ key, timeoutMs: 60000 });
    await sessions.delete({ key, deleteTranscript: true });
    assert.deepEqual(await sessions.list({ agentId, label }), []);
    assert.equal((await sessions.describe({ key })).session, null);
    run.unsubscribe();
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);

test("Hermes contract: abort interrupts a streaming turn", options, async (t) => {
  const box = await sandbox(t);
  const { dirs } = box;
  const { sessions, events, stop } = await hermes(t, box);
  const { key } = await sessions.create({ agentId, label });
  const run = collectEvents(events);
  await sessions.send({ key, turn: { message: "SLOW please" }, idempotencyKey: "slow" });
  await run.until((e) => e.runId === "slow" && e.kind === "text");
  const interrupted = await sessions.abort({ key, runId: "slow" });
  assert.equal(interrupted.status, "interrupted");
  const end = await run.until(endsRun("slow"), 60000);
  assert.equal(end.kind, "aborted");
  assert.equal(end.payload.status, "interrupted");
  assert.deepEqual(await sessions.wait({ runId: "slow", waitMs: 1 }), {
    runId: "slow",
    status: "aborted",
    aborted: true,
  });
  run.unsubscribe();
  await stop();
  assert.deepEqual(await strayAfterStop(dirs), []);
});

test(
  "Hermes contract: a restarted process resumes the stored session with its history",
  options,
  async (t) => {
    const box = await sandbox(t);
    const { dirs } = box;
    const first = await hermes(t, box);
    const { key } = await first.sessions.create({ agentId, label });
    const run = collectEvents(first.events);
    await first.sessions.send({
      key,
      turn: { message: "RUN: echo stored" },
      idempotencyKey: "r1",
    });
    assert.equal((await run.until(endsRun("r1"))).kind, "finished");
    // The terminal call is a tool step of the run, by its call id, without a label.
    const tools = run.seen.filter((e) => e.runId === "r1" && e.step?.type === "tool");
    assert.ok(tools.some((e) => e.step.phase === "start"));
    assert.ok(tools.some((e) => e.step.phase === "end"));
    assert.ok(tools.every((e) => e.step.title === null && e.step.name === "terminal"));
    const steps = new RunSteps();
    for (const e of run.seen) steps.observe(e);
    assert.deepEqual(
      steps
        .view("r1")
        .steps.filter((s) => s.kind === "tool")
        .map((s) => [s.tool, s.label, s.state]),
      [["terminal", "", "done"]],
    );
    const before = await first.sessions.history({ sessionKey: key });
    // An owner's restart replaces the connection: a view bound to the old one refuses,
    // the current one reaches the same session.
    const connection = first.runtime.host.connection();
    await first.runtime.host.restart();
    assert.notEqual(first.runtime.host.connection(), connection);
    await assert.rejects(
      first.sessions.on(connection).history({ sessionKey: key }),
      (e) => e.code === "UNAVAILABLE" && e.status === 503,
    );
    assert.deepEqual(
      (await first.sessions.history({ sessionKey: key })).messages.length,
      before.messages.length,
    );
    await first.stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
    // The handle of the stopped process reaches nothing.
    await assert.rejects(
      first.sessions.history({ sessionKey: key }),
      (e) => e.status === 503,
    );

    const second = await hermes(t, box);
    assert.deepEqual(
      (await second.sessions.list({ agentId, label })).map((s) => s.key),
      [key],
    );
    const after = await second.sessions.history({ sessionKey: key });
    assert.deepEqual(
      after.messages.map((m) => [m.role, m.text ?? null]),
      before.messages.map((m) => [m.role, m.text ?? null]),
    );
    // Entry ids are durable: the same rows keep them after a restart.
    assert.deepEqual(
      after.messages.map((m) => m.entry.id),
      before.messages.map((m) => m.entry.id),
    );
    assert.equal(
      new Set(after.messages.map((m) => m.entry.id)).size,
      after.messages.length,
    );
    assert.ok(after.messages.some((m) => m.role === "tool"));
    const next = collectEvents(second.events);
    await second.sessions.send({ key, turn: { message: "again" }, idempotencyKey: "r2" });
    assert.equal((await next.until(endsRun("r2"))).kind, "finished");
    const last = await second.sessions.history({ sessionKey: key, limit: 1 });
    assert.equal(last.messages[0].text, "ECHO: again");
    next.unsubscribe();
    await second.stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);
