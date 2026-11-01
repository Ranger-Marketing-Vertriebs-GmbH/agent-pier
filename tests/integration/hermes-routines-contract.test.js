import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import {
  hermesSandbox,
  hermesSkip,
  startHermes,
  strayAfterStop,
} from "../helpers/hermes-native.js";
import { writePrivate } from "../../server/lib/storage.js";
import { routineRunOf } from "../../server/features/assistants/runtimes/runtime-for.js";

// The Hermes adapter's routines against the pinned Hermes as AgentPier runs it: jobs
// on the cron of the agent's supervised messaging gateway, reached over the REST
// routes the gateway hosts through the RPC bridge (hermes-routines.js), and their
// results posted to AgentPier's completion webhook, here a listener of the test with
// the webhook's token in the sandbox (reminder-webhook.js).
const options = { skip: hermesSkip, timeout: contractTimeout(600000) };
const agentId = "hermes-agent";
const token = "a".repeat(64);

async function webhook(t) {
  const received = [];
  const waiters = new Set();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const event = {
        path: req.url,
        auth: req.headers.authorization,
        ...JSON.parse(raw),
      };
      received.push(event);
      for (const waiter of [...waiters]) waiter(event);
      res.writeHead(204).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const next = (match, timeoutMs = 120000) =>
    received.find(match) ||
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("no completion arrived")), timeoutMs);
      const waiter = (event) => {
        if (!match(event)) return;
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(event);
      };
      waiters.add(waiter);
    });
  return { url, received, next };
}

const routine = (url, extra = {}) => ({
  name: "Inbox check",
  marker: "agentpier-reminder:3b0e6d58-0b2a-4b5e-9a39-4c7c4f0a1b11",
  agentId,
  enabled: true,
  keepAfterRun: true,
  schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
  wakeNow: true,
  alertOnFailure: false,
  target: { kind: "chat", sessionKey: `agent:${agentId}:hermes:local-chat` },
  prompt: {
    text: "ROUTINE: look at the inbox",
    timeoutSeconds: 300,
    fullContext: true,
    tools: ["read"],
  },
  delivery: { kind: "chat", url: `${url}/complete/3b0e6d58-0b2a-4b5e-9a39-4c7c4f0a1b11` },
  ...extra,
});
const definitionOf = ({
  name,
  marker,
  agentId: id,
  schedule,
  target,
  prompt,
  delivery,
}) => ({
  name,
  marker,
  agentId: id,
  schedule,
  target,
  prompt,
  delivery,
});

test(
  "Hermes contract: routines run on the gateway's cron and deliver to AgentPier",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const dirs = hermesSandbox(t);
    const hook = await webhook(t);
    writePrivate(path.join(dirs.root, "assistants", "reminder-webhook.json"), {
      port: 1,
      token,
    });
    const { runtime, sessions, agent, stop } = await startHermes(t, dirs, {
      agentId,
      model,
    });
    const { routines } = runtime;
    assert.deepEqual(await routines.status(), { enabled: true });
    const want = routine(hook.url);
    const added = await routines.add({ routine: want });
    assert.match(added.id, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(definitionOf(added), definitionOf(want));
    assert.equal(added.enabled, true);
    assert.ok(added.runState.nextRunAtMs > Date.now());
    // Listed with what it runs; another agent's listing is empty.
    assert.deepEqual(
      (await routines.list({ agentId })).map((r) => definitionOf(r)),
      [definitionOf(want)],
    );
    assert.deepEqual(await routines.list({ agentId: "someone-else" }), []);
    // Paused, then changed in place: a patch changes only the fields it names.
    const paused = await routines.update({ id: added.id, patch: { enabled: false } });
    assert.equal(paused.enabled, false);
    assert.notEqual(paused.revision, added.revision);
    const prompt = { ...want.prompt, text: "ROUTINE: summarize the inbox" };
    const changed = await routines.update({
      id: added.id,
      patch: { name: "Summary", prompt },
    });
    assert.deepEqual(
      [changed.name, changed.prompt, changed.target, changed.enabled],
      ["Summary", prompt, want.target, false],
    );
    // A disabled routine runs only when forced, and stays paused after it.
    assert.deepEqual(await routines.run({ id: added.id }), {
      queued: false,
      refused: true,
    });
    assert.deepEqual(await routines.run({ id: added.id, force: true }), {
      queued: true,
      refused: false,
    });
    const event = await hook.next((e) => e.jobId === added.id);
    assert.equal(event.path, "/complete/3b0e6d58-0b2a-4b5e-9a39-4c7c4f0a1b11");
    assert.equal(event.auth, `Bearer ${token}`);
    assert.equal(event.status, "ok");
    assert.match(event.summary, /^ECHO: .*ROUTINE: summarize the inbox$/s);
    assert.ok(Number.isSafeInteger(event.runAtMs));
    assert.equal(event.deliveryStatus, "not-delivered");
    const [after] = await routines.list({ agentId });
    assert.equal(after.enabled, false);
    assert.equal(after.runState.lastStatus, "ok");
    assert.equal(after.runState.lastDeliveryStatus, "delivered");
    // The run's session names the routine and its run, and its transcript reads.
    const run = routineRunOf(null, event.sessionKey);
    assert.equal(run.agentId, agentId);
    assert.equal(run.routineId, added.id);
    assert.equal(typeof run.runId, "string");
    assert.deepEqual(routines.runOf(run.routineSession), { ...run, runId: null });
    const history = await sessions.history({ sessionKey: event.sessionKey, limit: 20 });
    assert.equal(history.messages.at(-1).entry.text, event.summary);
    const { entries } = await routines.runs({ id: added.id, limit: 20 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, "ok");
    assert.equal(entries[0].sessionKey, event.sessionKey);
    // Every schedule kind AgentPier offers reads back as given.
    const at = await routines.add({
      routine: routine(hook.url, {
        marker: "agentpier-reminder:at",
        target: { kind: "own" },
        delivery: { kind: "webhook", url: `${hook.url}/complete/at` },
        schedule: { kind: "at", at: "2099-11-02T09:00:00Z" },
        prompt: { text: "Remind me", timeoutSeconds: 90, fullContext: false, tools: [] },
      }),
    });
    assert.deepEqual(at.schedule, { kind: "at", at: "2099-11-02T09:00:00Z" });
    assert.deepEqual(at.target, { kind: "own" });
    const every = await routines.add({
      routine: routine(hook.url, {
        marker: "agentpier-reminder:every",
        schedule: { kind: "every", everyMs: 3600000 },
      }),
    });
    assert.deepEqual(every.schedule, { kind: "every", everyMs: 3600000 });
    // A schedule Hermes cannot keep is refused before anything is created.
    await assert.rejects(
      routines.add({
        routine: routine(hook.url, { schedule: { kind: "every", everyMs: 1500 } }),
      }),
      (e) => e.code === "INVALID_REQUEST",
    );
    assert.equal((await routines.list({ agentId })).length, 3);
    // A restart keeps the jobs and delivers no run twice.
    await runtime.host.restart();
    assert.equal((await routines.list({ agentId })).length, 3);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(hook.received.filter((e) => e.jobId === added.id).length, 1);
    for (const id of [added.id, at.id, every.id]) await routines.remove({ id });
    assert.deepEqual(await routines.list({ agentId }), []);
    assert.ok(fs.existsSync(path.join(agent.hermesHome, "cron", "jobs.json")));
    await stop();
    await assert.rejects(routines.list({ agentId }), (e) => e.code === "UNAVAILABLE");
    assert.deepEqual(await strayAfterStop(dirs), []);
  },
);
