import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contractTimeout } from "../helpers/contract-timeout.js";
import {
  dreamingKey,
  dreamingOn,
  installed,
  nativeFixture,
  snapshot,
} from "../helpers/assistant-dreaming-fixture.js";

const options = { skip: !installed, timeout: contractTimeout(420000) };
const memory = { memory: true, reminders: false };

test(
  "no per-agent lever keeps a temporary member out of the sweep",
  options,
  async (t) => {
    const f = await nativeFixture(t);
    const lead = await f.create("Orchid", memory, "orchid-model");
    const fern = await f.create("Fern", memory, "fern-model");
    const member = f.store.reserveMember({
      id: crypto.randomUUID(),
      parent: lead.id,
      assignment: { name: "Tasker", role: "helper", assignment: "check soil" },
      snapshot: {
        model: { connectionId: "fixture", modelId: "task-model" },
        instructions: "",
      },
      teamId: "team",
      lifetime: "task",
    });
    await f.config.apply(member.id);
    const task = f.store.getAssistant(member.id);
    assert.ok(task.inherited, "a temporary member that inherits from its lead");
    await f.turn(lead, "The orchids need repotting DREAMORCHID.");
    await f.turn(fern, "The ferns need misting DREAMFERN.");
    await f.turn(task, "Soil check for the lead DREAMTASK.");
    const entry = async () =>
      (await f.effective()).agents.entries[task.runtimeAgentId] ?? null;
    t.diagnostic(`compiled temporary member entry: ${JSON.stringify(await entry())}`);
    await f.dreaming(dreamingOn);
    const job = await f.job();
    assert.equal((await f.forceRun(job.id)).status, "ok");
    await f.settle({ files: [f.diary(lead), f.diary(fern), f.diary(task)] });
    assert.match(
      f.corpus(task),
      /DREAMTASK/,
      "memory-core sweeps every configured agent",
    );
    t.diagnostic(
      `temporary member workspace after the sweep: ${JSON.stringify(Object.keys(snapshot(f.workspace(task))))}`,
    );

    // Candidate lever: the member's own memory search off (R2: would not count, as it
    // takes the member's memory search away). Even this does not keep it out.
    await f.patch({
      agents: {
        entries: { [task.runtimeAgentId]: { memory: { search: { enabled: false } } } },
      },
    });
    assert.equal((await entry()).memory.search.enabled, false);
    await f.turn(task, "Second soil check DREAMTASKTWO.");
    await f.turn(lead, "Orchids repotted DREAMORCHIDTWO.");
    assert.equal((await f.forceRun(job.id)).status, "ok");
    await f.settle();
    assert.match(
      f.corpus(task),
      /DREAMTASKTWO/,
      "memory.search.enabled=false is no lever",
    );
    assert.match(f.corpus(lead), /DREAMORCHIDTWO/);
    assert.doesNotMatch(f.corpus(lead), /DREAMTASK/);
    assert.doesNotMatch(f.corpus(fern), /DREAMTASK|DREAMORCHID/);

    // The only agent-scoped dreaming RPC memory-core registers is session backfill; it
    // stages candidates and diary entries, it is not the light/REM/deep sweep.
    const preview = await f.call("memory.sessionBackfill.preview", {
      agentId: lead.runtimeAgentId,
    });
    t.diagnostic(`memory.sessionBackfill.preview(lead): ${JSON.stringify(preview)}`);
    assert.deepEqual(Object.keys(preview).toSorted(), [
      "candidates",
      "days",
      "perDay",
      "staged",
      "truncated",
    ]);
    // Neither the sweep trigger nor any Gateway method takes an agent filter: the
    // managed job's turn runs on the default agent and sweeps every agents.entries
    // workspace (memory-core resolveMemoryDreamingWorkspaces).
    const runs = (await f.call("cron.runs", { id: job.id, limit: 5 })).entries.filter(
      (r) => r.action === "finished",
    );
    t.diagnostic(
      `dreaming run session keys: ${JSON.stringify(runs.map((r) => r.sessionKey))}`,
    );
    assert.equal(runs.length, 2);
    for (const run of runs)
      assert.ok(
        run.sessionKey.startsWith(`agent:main:cron:${job.id}:run:`),
        run.sessionKey,
      );
  },
);

test(
  "a shared agent dreams over every chat; memory_search returns no raw corpus",
  options,
  async (t) => {
    const f = await nativeFixture(t);
    const shared = await f.create("Shared", memory, "orchid-model");
    const [userA, userB] = [crypto.randomUUID(), crypto.randomUUID()];
    // Labels as conversation-open.js gives the owner's and each user's main chat.
    await f.turn(shared, "Owner likes jasmine tea DREAMOWNER.", `AgentPier ${shared.id}`);
    await f.turn(
      shared,
      "User A likes rooibos DREAMUSERA.",
      `AgentPier ${shared.id} ${userA}`,
    );
    const keyB = await f.turn(
      shared,
      "User B likes mate DREAMUSERB.",
      `AgentPier ${shared.id} ${userB}`,
    );
    await f.dreaming(dreamingOn);
    const job = await f.job();
    assert.equal((await f.forceRun(job.id)).status, "ok");
    await f.settle({ files: [f.diary(shared)] });
    const corpus = f.corpus(shared);
    for (const marker of ["DREAMOWNER", "DREAMUSERA", "DREAMUSERB"])
      assert.match(corpus, new RegExp(marker));
    const files = snapshot(f.workspace(shared));
    t.diagnostic(
      `dream notes carrying markers: ${JSON.stringify(
        Object.entries(files)
          .filter(([name]) => !name.startsWith("memory/.dreams/"))
          .map(([name, content]) => [
            name,
            ["DREAMOWNER", "DREAMUSERA", "DREAMUSERB"].filter((m) => content.includes(m)),
          ])
          .filter(([, found]) => found.length),
      )}`,
    );
    const invoke = (name, args) =>
      f.call("tools.invoke", {
        name,
        agentId: shared.runtimeAgentId,
        sessionKey: keyB,
        args,
      });
    const search = await invoke("memory_search", { query: "DREAMUSERA", maxResults: 12 });
    const results = search.output?.details?.results ?? [];
    t.diagnostic(
      `memory_search from user B: ok=${search.ok} ${JSON.stringify(search).slice(0, 2500)}`,
    );
    assert.equal(
      results.some((r) => String(r.path).startsWith("memory/.dreams/")),
      false,
      "stop (b): memory_search returns raw corpus",
    );
    const [day] = fs.readdirSync(
      path.join(f.workspace(shared), "memory", ".dreams", "session-corpus"),
    );
    const read = await invoke("read", { path: `memory/.dreams/session-corpus/${day}` });
    t.diagnostic(
      `tools.invoke read memory/.dreams/session-corpus/${day}: ok=${read.ok} holdsUserA=${JSON.stringify(read).includes("DREAMUSERA")} ${JSON.stringify(read).slice(0, 600)}`,
    );
  },
);

test(
  "a sweep during a running turn neither blocks it nor opens agent sessions",
  options,
  async (t) => {
    const f = await nativeFixture(t);
    const busy = await f.create("Busy", memory, "orchid-model");
    const idle = await f.create("Idle", memory, "fern-model");
    await f.turn(busy, "Busy remembers the river DREAMBUSY.");
    await f.turn(idle, "Idle remembers the hill DREAMIDLE.");
    await f.dreaming(dreamingOn);
    const job = await f.job();
    const before = { busy: await f.sessions(busy), idle: await f.sessions(idle) };
    let slowSeen = false;
    f.model.reply = (request) => {
      if (JSON.stringify(request.messages).includes("DREAMSLOW")) {
        slowSeen = true;
        return { text: "Slow reply.", delayMs: 15000 };
      }
      return { text: "A useful assistant reply." };
    };
    const runId = await f.send(before.busy[0].key, "Think slowly DREAMSLOW.");
    await f.until(() => slowSeen, 30000, "the slow turn's model call");
    const run = await f.forceRun(job.id);
    assert.equal(run.status, "ok", JSON.stringify(run));
    const done = await f.wait(runId);
    assert.equal(done.status, "ok", JSON.stringify(done));
    await f.settle({ files: [f.diary(busy)] });
    assert.equal((await f.sessions(busy)).length, before.busy.length);
    assert.equal((await f.sessions(idle)).length, before.idle.length);
    assert.match(f.corpus(busy), /DREAMBUSY/);
    t.diagnostic(`busy sweep run: ${JSON.stringify(run)}`);
  },
);

test(
  "the managed schedule fires without cron.run under the hardened heartbeat",
  options,
  async (t) => {
    const f = await nativeFixture(t);
    const agent = await f.create("Sleeper", memory, "orchid-model");
    assert.equal((await f.effective()).agents.defaults.heartbeat.every, "0m");
    await f.turn(agent, "Sleeper remembers the moon DREAMSCHEDULE.");
    const at = new Date(Date.now() + (new Date().getUTCSeconds() > 45 ? 120000 : 60000));
    const expr = `${at.getUTCMinutes()} ${at.getUTCHours()} * * *`;
    await f.dreaming({ ...dreamingOn, frequency: expr, timezone: "UTC" });
    const job = await f.until(
      async () => (await f.dreamingJobs()).find((j) => j.schedule.expr === expr),
      30000,
      "the scheduled job",
    );
    const run = await f.finished(job.id, 0, 150000);
    t.diagnostic(`scheduled run (no cron.run): ${JSON.stringify(run)}`);
    assert.equal(run.status, "ok");
    await f.settle({ files: [f.diary(agent)] });
    assert.match(f.corpus(agent), /DREAMSCHEDULE/);

    const other = `0 ${(at.getUTCHours() + 5) % 24} * * *`;
    await f.dreaming({ frequency: other });
    const moved = await f.until(
      async () => {
        const jobs = await f.dreamingJobs();
        return jobs.length === 1 && jobs[0].schedule.expr === other && jobs;
      },
      30000,
      "one job at the new hour",
    );
    assert.equal(moved[0].declarationKey, dreamingKey);
    t.diagnostic(`after hour change: ${JSON.stringify(moved)}`);
    await f.dreaming({ enabled: false });
    await f.until(async () => (await f.dreamingJobs()).length === 0, 30000, "no job");
  },
);

test(
  "under a symlinked data directory the sweep writes no corpus",
  options,
  async (t) => {
    const f = await nativeFixture(t, { resolve: false });
    const agent = await f.create("Linked", memory, "orchid-model");
    await f.turn(agent, "Linked remembers the lake DREAMLINKED.");
    await f.dreaming(dreamingOn);
    const job = await f.job();
    const run = await f.forceRun(job.id);
    await f.settle();
    await delay(1000);
    assert.doesNotMatch(f.corpus(agent), /DREAMLINKED/);
    const logs = Object.values(snapshot(f.runtime.paths.logs)).join("\n");
    const line = logs.split("\n").find((l) => l.includes("no longer current"));
    t.diagnostic(`run=${JSON.stringify(run)} log=${line?.slice(0, 800)}`);
    assert.match(logs, /Canonical session reader continuation is no longer current/);
  },
);
