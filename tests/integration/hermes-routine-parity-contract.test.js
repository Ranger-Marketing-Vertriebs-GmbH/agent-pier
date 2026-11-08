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
  contractAgent,
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
// routine run runs with full shell access and on approval levels asks the owner
// through AgentPier's team bridge (refused without it: Hermes's cron asks no one); a result arriving during a turn of its chat follows that
// turn's reply; and a chat names how full its context is for the long-chat hint, also
// after a gateway restart. Results go to a completion webhook of the test with the sandbox's token.
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

    // A result that arrives while a turn of its chat runs follows that turn's reply.
    const slow = await sessions.send({
      key,
      turn: { message: "SLOW reply while the routine reports" },
      idempotencyKey: "slow-turn",
    });
    await seen.until((e) => e.runId === slow.runId && e.kind === "text", 120000);
    const reported = hook.received.filter((e) => e.jobId === into.id).length;
    await routines.run({ id: into.id, force: true });
    await eventually(
      () => hook.received.filter((e) => e.jobId === into.id).length > reported,
      240000,
      "the second routine completion",
    );
    const slowEnd = await seen.until(endsRun(slow.runId), 240000);
    assert.equal(slowEnd.kind, "finished");
    let rows = [];
    await eventually(
      async () =>
        (rows = (await sessions.history({ sessionKey: key })).messages).filter(
          (m) => m.display_kind === "internal_notification",
        ).length === 2,
      120000,
      "the second note",
    );
    const reply = rows.findIndex((m) => m.role === "assistant" && /SLOW/.test(m.text));
    const second = rows.findLastIndex((m) => m.display_kind === "internal_notification");
    assert.ok(
      reply >= 0 && second > reply,
      `the note stands after the turn's reply: ${JSON.stringify(
        rows.map((m) => [m.role, m.display_kind ?? null, String(m.text).slice(0, 40)]),
      )}`,
    );

    // After a gateway restart the size read last stands until the next model call.
    await supervisor.restart();
    let after = null;
    await eventually(
      async () => (after = await sessions.history({ sessionKey: key }).catch(() => null)),
      120000,
      "the chat after the restart",
    );
    assert.equal(after.sessionInfo.totalTokens, 100000);
    assert.equal(longContext(after.sessionInfo), true);

    for (const id of [zoned.id, into.id]) await routines.remove({ id });
    await stop();
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);

// AgentPier's team bridge as far as the guard plugin's question needs it
// (hermes-routine-approvals.js, unit-tested there): `/hermes-approval` asks through the
// agent's approvals sub-port and waits for the answer `decide` gives the request.
async function approvalBridge(t, runtime, decide) {
  const bridgeToken = "c".repeat(64);
  const asked = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const input = JSON.parse(raw || "null");
      if (
        req.url !== "/hermes-approval" ||
        req.headers.authorization !== `Bearer ${bridgeToken}`
      )
        return res.writeHead(404).end("{}");
      asked.push(input);
      const decision = await runtime.approvals.ask({
        sessionKey: input.sessionKey,
        command: input.command,
        description: input.description,
      });
      res.end(
        JSON.stringify(
          decision === "allow-once"
            ? { allow: true }
            : { allow: false, message: "BLOCKED: the owner denied this command." },
        ),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // The owner answers each request as it appears, on the connection the set has
  // once it runs with the bridge (a restart opens a new one).
  const answer = () =>
    t.after(
      runtime.events.subscribe((e) => {
        if (e.kind === "approval.requested")
          runtime.approvals
            .resolve({ id: e.payload.id, decision: decide(e.payload) })
            .catch(() => {});
      }),
    );
  return {
    asked,
    answer,
    connection: { url: `http://127.0.0.1:${server.address().port}`, token: bridgeToken },
  };
}

// One routine run of `command` under shell level `shell`: its completion. `decide`:
// with it the agent has AgentPier's team bridge and the owner answers its question.
async function runCommand(t, shell, command, decide) {
  const model = await startFakeModel();
  t.after(() => model.close());
  const dirs = hermesSandbox(t);
  const hook = await webhook(t, dirs);
  const started = await startHermes(t, dirs, { agentId, model, shell });
  let bridge = null;
  if (decide) {
    bridge = await approvalBridge(t, started.runtime, decide);
    await started.runtime.config.apply({
      desired: contractAgent(agentId, model, { shell }),
      connection: bridge.connection,
    });
    await eventually(() => started.runtime.host.ready(), 180000, "the restarted set");
    bridge.answer();
  }
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
  return { done, removed, asked: bridge?.asked ?? [], jobId: job.id };
}

test(
  "Hermes contract: the owner's time zone reaches the agent's cron through its environment",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const dirs = hermesSandbox(t);
    const hook = await webhook(t, dirs);
    // The owner's Time zone for all agents (hermes-config/advanced.js): passed as
    // HERMES_TIMEZONE, never written into config.yaml.
    const zone = otherZone();
    const { runtime, agent } = await startHermes(t, dirs, {
      agentId,
      model,
      advanced: { userTimezone: zone },
    });
    const config = fs.readFileSync(path.join(agent.hermesHome, "config.yaml"), "utf8");
    assert.doesNotMatch(config, /^timezone:/m);
    // A routine in that zone runs as written, and Hermes's own scheduler computes its
    // next run in that zone, not the host's.
    const schedule = { kind: "cron", expression: "0 9 * * *", timezone: zone };
    const local = await runtime.routines.add({
      routine: routine(hook.url, { enabled: true, schedule }),
    });
    const jobs = JSON.parse(
      fs.readFileSync(path.join(agent.hermesHome, "cron", "jobs.json"), "utf8"),
    );
    const job = (Array.isArray(jobs) ? jobs : jobs.jobs).find((j) => j.id === local.id);
    assert.equal(job.schedule.expr, "0 9 * * *");
    assert.equal(local.runState.nextRunAtMs, nextCronRun("0 9 * * *", zone, Date.now()));
    await runtime.routines.remove({ id: local.id });
  },
);

test(
  "Hermes contract: a routine run's dangerous command follows the agent's shell level",
  options,
  async (t) => {
    // Full access runs it, as on OpenClaw.
    const full = await runCommand(t, "full", "rm -rf victim");
    assert.equal(full.done.status, "ok");
    assert.match(full.done.summary, /^TOOL_DONE: /);
    assert.equal(full.removed, true);
    // Without AgentPier's bridge no one can answer a cron run's question: Hermes
    // refuses it (approvals.cron_mode deny).
    const unasked = await runCommand(t, "approval", "rm -rf victim");
    assert.equal(unasked.done.status, "ok");
    assert.match(unasked.done.summary, /BLOCKED/);
    assert.equal(unasked.removed, false);
    // With it the guard asks the owner, as OpenClaw does: an allow runs it ...
    const allowed = await runCommand(t, "approval", "rm -rf victim", () => "allow-once");
    assert.equal(allowed.asked.length, 1);
    assert.equal(allowed.asked[0].command, "rm -rf victim");
    assert.equal(allowed.asked[0].kind, "command");
    assert.match(
      allowed.asked[0].sessionKey,
      new RegExp(`^agent:${agentId}:hermes:cron:${allowed.jobId}:[^:]+$`),
    );
    assert.match(allowed.done.summary, /^TOOL_DONE: /);
    assert.equal(allowed.removed, true);
    // ... a denial refuses it, and a harmless command asks nobody.
    const denied = await runCommand(t, "approval", "rm -rf victim", () => "deny");
    assert.equal(denied.asked.length, 1);
    assert.match(denied.done.summary, /BLOCKED/);
    assert.equal(denied.removed, false);
    const harmless = await runCommand(t, "approval", "ls victim", () => "deny");
    assert.deepEqual(harmless.asked, []);
    assert.match(harmless.done.summary, /^TOOL_DONE: /);
  },
);
