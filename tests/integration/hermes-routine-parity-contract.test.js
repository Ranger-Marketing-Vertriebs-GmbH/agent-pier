import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import {
  endsRun,
  collectEvents,
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";
import { writePrivate } from "../../server/lib/storage.js";
import { longContext } from "../../server/features/assistants/conversations.js";
import { hermesRest } from "../../server/features/assistants/runtimes/hermes/hermes-routines.js";
import {
  nextCronRun,
  processZone,
} from "../../server/features/assistants/runtimes/hermes/hermes-cron-zone.js";

// Hermes routines as OpenClaw's run, on the pinned Hermes as AgentPier runs it
// (AGENTPIER_HERMES_CONTRACT_RUNTIME): a routine in another time zone than the agent's
// processes is due at its own zone's time; a routine's result is written into its
// chat's history, where the agent's next turn reads it; a dangerous command in a
// routine run runs with full shell access and is refused on approval levels (Hermes's
// cron cannot ask anyone); and a chat names how full its context is for the long-chat
// hint. Results go to a completion webhook of the test with the sandbox's token.
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };
const agentId = "hermes-agent";
const token = "b".repeat(64);

async function webhook(t, dirs) {
  writePrivate(path.join(dirs.root, "assistants", "reminder-webhook.json"), {
    port: 1,
    token,
  });
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push({ path: req.url, ...JSON.parse(raw) });
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const next = async (match, ms = 240000) => {
    let hit = null;
    await eventually(() => (hit = received.find(match)), ms, "a routine completion");
    return hit;
  };
  return { url, received, next };
}

const routine = (url, extra = {}) => ({
  name: "Parity",
  marker: "agentpier-reminder:parity",
  agentId,
  enabled: false,
  keepAfterRun: true,
  schedule: { kind: "cron", expression: "0 9 * * *" },
  wakeNow: true,
  alertOnFailure: false,
  target: { kind: "own" },
  prompt: { text: "ROUTINE: hello", timeoutSeconds: 300, fullContext: true, tools: [] },
  delivery: { kind: "webhook", url: `${url}/complete/parity` },
  ...extra,
});

// A zone other than this process's, with no daylight saving time.
const otherZone = () =>
  processZone() === "Asia/Tokyo" ? "Pacific/Honolulu" : "Asia/Tokyo";

test(
  "Hermes contract: zoned routines, results in the chat's history and the long-chat size",
  options,
  async (t) => {
    const model = await startFakeModel({ promptTokens: 100000 });
    t.after(() => model.close());
    const dirs = hermesSandbox(t);
    const hook = await webhook(t, dirs);
    const { runtime, sessions, events, agent, supervisor, stop } = await startHermes(
      t,
      dirs,
      { agentId, model },
    );
    const { routines } = runtime;

    // Due at 09:00 in its own zone, wherever the agent's processes run.
    const zone = otherZone();
    const schedule = { kind: "cron", expression: "0 9 * * *", timezone: zone };
    const zoned = await routines.add({
      routine: routine(hook.url, {
        marker: "agentpier-reminder:zoned",
        enabled: true,
        schedule,
      }),
    });
    const due = nextCronRun("0 9 * * *", zone, Date.now());
    assert.equal(zoned.runState.nextRunAtMs, due);
    assert.deepEqual(zoned.schedule, schedule);
    const stored = () =>
      JSON.parse(
        fs.readFileSync(path.join(agent.hermesHome, "cron", "jobs.json"), "utf8"),
      );
    const jobOf = () => {
      const file = stored();
      return (Array.isArray(file) ? file : file.jobs).find((j) => j.id === zoned.id);
    };
    assert.notEqual(jobOf().schedule.expr, "0 9 * * *");
    // A pin whose occurrence passed (the run happened) moves to the next occurrence.
    await hermesRest(supervisor.client, "PUT", `/api/cron/jobs/${zoned.id}`, {
      body: { updates: { schedule: "0 0 1 1 *" } },
    });
    await eventually(
      async () =>
        (await routines.list({ agentId })).find((r) => r.id === zoned.id)?.runState
          .nextRunAtMs === due,
      60000,
      "the routine pinned to its next occurrence again",
    );

    // A routine that delivers into a chat writes its result into that chat's history.
    const { key } = await sessions.create({ agentId, label: "Main chat" });
    const into = await routines.add({
      routine: routine(hook.url, {
        marker: "agentpier-reminder:chat",
        name: "Inbox check",
        target: { kind: "chat", sessionKey: key },
        prompt: {
          text: "ROUTINE: three new mails",
          timeoutSeconds: 300,
          fullContext: true,
          tools: [],
        },
        delivery: { kind: "chat", url: `${hook.url}/complete/chat` },
      }),
    });
    await routines.run({ id: into.id, force: true });
    const done = await hook.next((e) => e.jobId === into.id);
    assert.equal(done.status, "ok");
    assert.match(done.summary, /ROUTINE: three new mails$/);
    const history = await sessions.history({ sessionKey: key });
    const note = history.messages.find((m) => m.display_kind === "internal_notification");
    assert.equal(note.text, `[Cron delivery: Inbox check]\n${done.summary}`);
    assert.equal(note.entry.internal, true);

    // The agent's next turn in that chat reads it.
    const seen = collectEvents(events);
    t.after(() => seen.unsubscribe());
    const before = model.requests.length;
    const { runId } = await sessions.send({
      key,
      turn: { message: "What did the routine find?" },
      idempotencyKey: "after-routine",
    });
    const end = await seen.until(endsRun(runId), 180000);
    assert.equal(end.kind, "finished");
    const asked = model.requests
      .slice(before)
      .find((r) =>
        JSON.stringify(r.body.messages).includes("What did the routine find?"),
      );
    assert.ok(asked, "the turn reached the model");
    assert.ok(
      JSON.stringify(asked.body.messages).includes("[Cron delivery: Inbox check]"),
    );

    // The chat names how full its context was: the hint's measure.
    const { sessionInfo } = await sessions.history({ sessionKey: key });
    assert.equal(sessionInfo.totalTokens, 100000);
    assert.equal(sessionInfo.contextTokens, 128000);
    assert.equal(longContext(sessionInfo), true);

    for (const id of [zoned.id, into.id]) await routines.remove({ id });
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);

// One routine run of `command` under shell level `shell`: its completion.
async function runCommand(t, shell, command) {
  const model = await startFakeModel();
  t.after(() => model.close());
  const dirs = hermesSandbox(t);
  const hook = await webhook(t, dirs);
  const started = await startHermes(t, dirs, { agentId, model, shell });
  const victim = path.join(started.agent.workspace, "victim");
  fs.mkdirSync(path.join(victim, "inner"), { recursive: true });
  const { routines } = started.runtime;
  const job = await routines.add({
    routine: routine(hook.url, {
      marker: `agentpier-reminder:${shell}`,
      prompt: {
        text: `RUN: ${command}`,
        timeoutSeconds: 300,
        fullContext: true,
        tools: ["exec"],
      },
    }),
  });
  await routines.run({ id: job.id, force: true });
  const done = await hook.next((e) => e.jobId === job.id);
  await routines.remove({ id: job.id });
  const removed = !fs.existsSync(victim);
  await started.stop();
  assert.deepEqual(await strayAfterStop(dirs), []);
  return { done, removed };
}

test(
  "Hermes contract: a routine run's dangerous command follows the agent's shell level",
  options,
  async (t) => {
    // Full access runs it, as on OpenClaw.
    const full = await runCommand(t, "full", "rm -rf victim");
    assert.equal(full.done.status, "ok");
    assert.match(full.done.summary, /^TOOL_DONE: /);
    assert.equal(full.removed, true);
    // On approval no one can answer a cron run's question: Hermes refuses it.
    const asked = await runCommand(t, "approval", "rm -rf victim");
    assert.equal(asked.done.status, "ok");
    assert.match(asked.done.summary, /BLOCKED/);
    assert.equal(asked.removed, false);
  },
);
