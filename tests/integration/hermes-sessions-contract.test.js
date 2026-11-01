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
  writeHermesConfig,
} from "../helpers/hermes-native.js";
import { hermesSessions } from "../../server/features/assistants/runtimes/hermes/hermes-sessions.js";
import { hermesEvents } from "../../server/features/assistants/runtimes/hermes/hermes-events.js";

// The Hermes adapter's sessions and run events against the real TUI gateway
// (`python -m tui_gateway.entry` of AGENTPIER_HERMES_CONTRACT_RUNTIME), with the
// in-repo fake model and a private HOME and HERMES_HOME (hermes-native.js).
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-agent";
const label = "AgentPier hermes-agent chat";

// The sessions and events sub-ports over one started gateway, as its supervisor's.
async function hermes(t, dirs) {
  const started = await startHermes(t, dirs, { agentId });
  const supervisor = { client: started.client, agentId };
  return {
    ...started,
    sessions: hermesSessions(supervisor),
    events: hermesEvents(supervisor),
  };
}

async function sandbox(t) {
  const model = await startFakeModel({ slowMs: 300 });
  t.after(() => model.close());
  const dirs = hermesSandbox(t);
  writeHermesConfig(dirs, model);
  return { dirs, model };
}

test(
  "Hermes contract: a session is created, streams a turn and is deleted",
  options,
  async (t) => {
    const { dirs } = await sandbox(t);
    const { sessions, events, stop } = await hermes(t, dirs);
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
    // The streamed deltas add up to the reply. Hermes appends a one-time intro note to
    // an install's very first message, whatever onboarding.profile_build says, so the
    // fake model's echo ends with that note's text rather than the message.
    const text = own
      .filter((e) => e.kind === "text")
      .map((e) => e.payload.text)
      .join("");
    assert.equal(text.trim(), end.payload.text.trim());
    assert.match(end.payload.text, /^ECHO: /);
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
  const { dirs } = await sandbox(t);
  const { sessions, events, stop } = await hermes(t, dirs);
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
    const { dirs } = await sandbox(t);
    const first = await hermes(t, dirs);
    const { key } = await first.sessions.create({ agentId, label });
    const run = collectEvents(first.events);
    await first.sessions.send({
      key,
      turn: { message: "RUN: echo stored" },
      idempotencyKey: "r1",
    });
    assert.equal((await run.until(endsRun("r1"))).kind, "finished");
    const before = await first.sessions.history({ sessionKey: key });
    await first.stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
    // The handle of the stopped process reaches nothing.
    await assert.rejects(
      first.sessions.history({ sessionKey: key }),
      (e) => e.status === 503,
    );

    const second = await hermes(t, dirs);
    assert.deepEqual(
      (await second.sessions.list({ agentId, label })).map((s) => s.key),
      [key],
    );
    const after = await second.sessions.history({ sessionKey: key });
    assert.deepEqual(
      after.messages.map((m) => [m.role, m.text ?? null]),
      before.messages.map((m) => [m.role, m.text ?? null]),
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
