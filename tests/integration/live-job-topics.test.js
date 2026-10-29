import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { manualTimers } from "../helpers/manual-timers.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { defineJobTopic, jobTopic } from "../../server/features/live/job-topics.js";
import {
  REA_JOB_SAMPLE_MS,
  defineToolJobTopics,
  reaJobChanged,
  toolJobsChanged,
} from "../../server/features/tools/live-topics.js";
import {
  toolInstallations,
  versionsSettled,
} from "../../server/features/tools/tool-installation-list.js";
import { ToolInstaller } from "../../server/features/tools/tool-installer.js";
import { ReaTool } from "../../server/features/tools/rea-tool.js";
import { uninstallRea } from "../../server/features/tools/rea-lifecycle.js";
import { toolBinDirectories } from "../../server/features/tools/tool-paths.js";
import { detectTools } from "../../server/features/accounts/account-store.js";
import { reportLiveError } from "../../server/application/live-wiring.js";

// The `job.<kind>:<id>` family (server/features/live/job-topics.js) and its tool,
// managed browser and REA kinds: each pushed value equals what its REST route answers.

const owner = { role: "owner" };
const user = { role: "user", userId: "u1" };

function errorsOf(t) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => {
    console.error = original;
  });
  return errors;
}

function listen(hub, topic, principal = owner) {
  const frames = [];
  const stop = hub.subscribe(principal, topic, undefined, (frame) => frames.push(frame));
  return { frames, stop };
}

/** Resolves with the first frame of `frames` (now or later) that passes `predicate`. */
async function frameWhere(frames, predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = frames.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`no matching frame in ${JSON.stringify(frames)}`);
}

test("defineJobTopic registers an owner-only job.<kind> sampled while it runs", async (t) => {
  const clock = manualTimers();
  const hub = new LiveHub({ timers: clock.timers });
  t.after(() => hub.close());
  const jobs = { a: { status: "running" } };
  let reads = 0,
    unwatched = 0;
  defineJobTopic(hub, {
    kind: "probe",
    param: /[a-z]/,
    sampleMs: 500,
    status: (value) => value.status,
    read: (id) => {
      reads += 1;
      return { ...jobs[id] };
    },
    watch: () => () => (unwatched += 1),
  });
  assert.throws(() => defineJobTopic(hub, { kind: "probe", read: () => ({}) }));
  assert.equal(listen(hub, "job.probe:a", user).frames[0].code, "unknown-topic");
  assert.equal(listen(hub, "job.probe:A", owner).frames[0].code, "unknown-topic");
  assert.equal(listen(hub, "job:probe:a", owner).frames[0].code, "unknown-topic");
  const { frames, stop } = listen(hub, "job.probe:a");
  await clock.advance(0);
  assert.deepEqual(frames[0].data, { status: "running" });
  await clock.advance(500);
  assert.equal(reads, 2);
  jobs.a.status = "succeeded";
  await clock.advance(500);
  assert.equal(frames.at(-1).data.status, "succeeded");
  const ended = reads;
  await clock.advance(5000);
  // An ended job is read again only when its source signals it.
  assert.equal(reads, ended);
  hub.invalidate("job.probe", "a");
  await clock.advance(1000);
  assert.equal(reads, ended + 1);
  stop();
  assert.equal(unwatched, 1);
  // A kind without sampleMs is never sampled.
  const plain = jobTopic({ kind: "plain", read: () => ({}) });
  assert.equal(plain.sampleMs, undefined);
  assert.equal(plain.sampling, undefined);
  assert.equal(plain.name, "job.plain");
});

// A ToolInstaller over a fake npm (tests/integration/tool-installer.test.js).
async function installerOf(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-job-topics-"));
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const npmCli = path.join(dir, "npm.js");
  await fs.writeFile(
    npmCli,
    `const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2),prefix=a[a.indexOf('--prefix')+1];setTimeout(()=>{fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});fs.writeFileSync(path.join(prefix,'bin','codex'),'#!'+process.execPath+'\\nconsole.log("1.2.3 fixture")\\n',{mode:0o700});},300);`,
  );
  const installer = new ToolInstaller({
    dataDir: dir,
    home,
    npmCli,
    detect: () => detectTools({ PATH: "", HOME: home }, false, toolBinDirectories(dir)),
    timeout: 5000,
    ...options,
  });
  const hub = new LiveHub({ debounceMs: 10, maxWaitMs: 50 });
  defineToolJobTopics(hub, { installer });
  installer.onChange = () => toolJobsChanged(hub);
  t.after(async () => {
    hub.close();
    await installer.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { installer, hub };
}

const entry = (value) => value.installations[0];

test("a tool installation pushes its progress and every tool's busy flag", async (t) => {
  const { installer, hub } = await installerOf(t);
  const codex = listen(hub, "job.tool:codex");
  const claude = listen(hub, "job.tool:claude");
  await frameWhere(codex.frames, (frame) => frame.type === "snapshot");
  await frameWhere(claude.frames, (frame) => frame.type === "snapshot");
  assert.equal(entry(codex.frames[0].data).status, "idle");
  assert.equal(codex.frames[0].data.busy, false);
  installer.start("codex", "npm");
  await frameWhere(codex.frames, (f) => f.type === "state" && f.data.busy);
  // Another tool's topic hears that the installer is busy.
  await frameWhere(claude.frames, (f) => f.type === "state" && f.data.busy);
  // The installed CLI's version is probed after the job ends; its answer is pushed.
  const done = await frameWhere(
    codex.frames,
    (f) =>
      f.type === "state" &&
      entry(f.data).status === "succeeded" &&
      !f.data.busy &&
      entry(f.data).versionStatus === "ok",
  );
  assert.equal(entry(done.data).installedVersion, "1.2.3");
  assert.deepEqual(done.data, await toolInstallations(installer, "codex"));
  assert.equal(entry(done.data).installed, true);
  await frameWhere(claude.frames, (f) => f.type === "state" && !f.data.busy);
  // Only the one tool's entry: no other installation, no secret field.
  assert.deepEqual(Object.keys(done.data).sort(), ["busy", "installations"]);
  assert.deepEqual(
    done.data.installations.map((item) => item.tool),
    ["codex"],
  );
});

test("the managed browser's job pushes on job.tool:chromium; job.chromium is gone", async (t) => {
  const { installer, hub } = await installerOf(t, {
    platform: "linux",
    arch: "x64",
    chromiumFetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw new Error("offline");
    },
  });
  const browser = listen(hub, "job.tool:chromium");
  await frameWhere(browser.frames, (frame) => frame.type === "snapshot");
  assert.equal(listen(hub, "job.chromium:current").frames[0].code, "unknown-topic");
  installer.start("chromium");
  const running = await frameWhere(
    browser.frames,
    (f) => f.type === "state" && entry(f.data).status === "running",
  );
  assert.equal(entry(running.data).tool, "chromium");
  const failed = await frameWhere(
    browser.frames,
    (f) => f.type === "state" && entry(f.data).status === "failed" && !f.data.busy,
  );
  assert.deepEqual(failed.data, await toolInstallations(installer, "chromium"));
});

test("every write path of the tool installer signals its change", async (t) => {
  const { installer } = await installerOf(t, {
    platform: "linux",
    arch: "x64",
    chromiumFetch: async () => {
      throw new Error("offline");
    },
  });
  const changes = [];
  installer.onChange = (tool) => changes.push([tool, !!installer.active]);
  installer.start("chromium");
  await installer.active.done;
  // Scheduled, progress, the job's end, and the installer no longer busy.
  assert.deepEqual(changes.at(0), ["chromium", true]);
  assert.ok(changes.length >= 3, JSON.stringify(changes));
  assert.deepEqual(changes.at(-1), ["chromium", false]);
  // A hook that throws never breaks an installation, and is logged.
  const errors = errorsOf(t);
  installer.onChange = () => {
    throw new Error("hub gone");
  };
  installer.start("chromium");
  await installer.active.done;
  assert.equal(
    installer.list().installations.find((x) => x.tool === "chromium").status,
    "failed",
  );
  assert.ok(
    errors.some((line) => line.includes("could not announce a tool installation")),
    JSON.stringify(errors),
  );
});

// A ReaTool over empty stores: enough for its job state and its hook.
async function reaOf(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-rea-job-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const rea = new ReaTool({
    dataDir,
    servers: { managed: null, list: () => [] },
    changes: {},
    packages: { records: { get: () => null, computedStatus: () => null } },
    extensions: {},
  });
  return rea;
}

test("REA signals the start, every step and the end of its jobs", async (t) => {
  const rea = await reaOf(t);
  const changes = [];
  rea.onChange = () => changes.push(rea.job ? rea.step || "running" : rea.status);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  rea.begin(async () => {
    rea.progress("core", "Lädt");
    await gate;
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await rea.settled();
  assert.deepEqual(changes, ["running", "core", "succeeded"]);
  changes.length = 0;
  await uninstallRea(rea);
  assert.equal(changes.at(-1), "idle");
  assert.ok(changes.includes("ghidra"), JSON.stringify(changes));
});

// A job that ends in the state it began with still changes jobCount, so its end is
// pushed and a dialog holding the start's `running` answer settles.
for (const [name, work] of [
  [
    "a retry that fails fast with the same message",
    async () => {
      throw new Error("offline");
    },
  ],
  ["a no-op apply from succeeded to succeeded", async () => {}],
])
  test(`REA pushes the end of ${name}`, async (t) => {
    const rea = await reaOf(t);
    const hub = new LiveHub({ debounceMs: 10, maxWaitMs: 50 });
    t.after(() => hub.close());
    defineToolJobTopics(hub, { rea });
    rea.onChange = () => reaJobChanged(hub);
    const errors = errorsOf(t);
    rea.begin(work);
    await rea.settled();
    const { frames } = listen(hub, "job.rea:current");
    const first = await frameWhere(frames, (frame) => frame.type === "snapshot");
    assert.notEqual(first.data.status, "running");
    // The second, identical job starts and ends inside one debounce window.
    rea.begin(work);
    const started = rea.state();
    assert.equal(started.status, "running");
    await rea.settled();
    const ended = await frameWhere(frames, (frame) => frame.type === "state");
    assert.equal(ended.data.status, first.data.status);
    assert.equal(ended.data.message, first.data.message);
    assert.equal(ended.data.jobCount, first.data.jobCount + 1);
    assert.equal(started.jobCount, ended.data.jobCount);
    assert.ok(errors.length <= 2);
  });

test("a running REA job is sampled every second; an idle one is not", async (t) => {
  assert.equal(REA_JOB_SAMPLE_MS, 1000);
  const clock = manualTimers();
  const hub = new LiveHub({ timers: clock.timers });
  t.after(() => hub.close());
  let status = "running",
    reads = 0;
  const rea = {
    state: () => {
      reads += 1;
      return { status, reads };
    },
  };
  defineToolJobTopics(hub, { rea });
  assert.equal(listen(hub, "job.rea:other").frames[0].code, "unknown-topic");
  const { frames, stop } = listen(hub, "job.rea:current");
  await clock.advance(0);
  assert.equal(frames[0].data.status, "running");
  await clock.advance(1000);
  assert.equal(reads, 2);
  status = "succeeded";
  await clock.advance(1000);
  assert.equal(frames.at(-1).data.status, "succeeded");
  const after = reads;
  await clock.advance(10000);
  assert.equal(reads, after);
  reaJobChanged(hub);
  await clock.advance(1000);
  assert.equal(reads, after + 1);
  stop();
});

test("the tool, browser and REA topics are the owner's alone", () => {
  const hub = new LiveHub();
  defineToolJobTopics(hub, {});
  for (const topic of ["job.tool:codex", "job.rea:current"]) {
    assert.equal(hub.resolve(user, topic), null, topic);
    assert.equal(hub.resolve(null, topic), null, topic);
    assert.ok(hub.resolve(owner, topic), topic);
  }
  hub.close();
});

test("refused job reads are expected and not logged", async (t) => {
  const errors = errorsOf(t);
  const hub = new LiveHub({ debounceMs: 10, maxWaitMs: 50, onError: reportLiveError });
  t.after(() => hub.close());
  // Without the MCP server store there is no REA (the route answers 503).
  defineToolJobTopics(hub, { installer: { list: () => ({ installations: [] }) } });
  const rea = listen(hub, "job.rea:current");
  const unknown = listen(hub, "job.tool:nothing");
  await frameWhere(rea.frames, (frame) => frame.type === "error");
  await frameWhere(unknown.frames, (frame) => frame.type === "error");
  assert.deepEqual(errors, []);
});

const json = async (f, route) => (await f.request(route)).json();

test("the job topics' snapshots and pushes equal their routes", async (t) => {
  const f = await applicationFixture(t);
  assert.equal((await f.request("/api/tool-installations?tool=nothing")).status, 404);
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  const first = {};
  for (const topic of ["job.tool:codex", "job.rea:current"]) {
    live.send({ op: "sub", topic });
    first[topic] = await live.next((frame) => frame.topic === topic, 5000);
    assert.equal(first[topic].type, "snapshot", topic);
  }
  // A version still probed at the snapshot (a CLI on this host) is pushed when known.
  let codex = first["job.tool:codex"];
  while (entry(codex.data).versionStatus === "checking")
    codex = await live.next((frame) => frame.topic === "job.tool:codex", 10000);
  assert.deepEqual(codex.data, await json(f, "/api/tool-installations?tool=codex"));
  const all = await json(f, "/api/tool-installations");
  assert.deepEqual(
    entry(codex.data),
    all.installations.find((item) => item.tool === "codex"),
  );
  assert.deepEqual(first["job.rea:current"].data, await json(f, "/api/rea"));
  // The wired hooks push: a REA job and a tool installation record.
  const { rea, installer } = f.application;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const running = live.next(
    (frame) => frame.topic === "job.rea:current" && frame.data.status === "running",
    5000,
  );
  rea.begin(() => gate);
  await running;
  const ended = live.next(
    (frame) => frame.topic === "job.rea:current" && frame.data.status === "succeeded",
    5000,
  );
  release();
  assert.deepEqual((await ended).data, await json(f, "/api/rea"));
  const failed = live.next(
    (frame) => frame.topic === "job.tool:codex" && entry(frame.data).status === "failed",
    5000,
  );
  installer.records.codex = {
    tool: "codex",
    status: "failed",
    message: "Fixture",
    version: null,
    startedAt: null,
    finishedAt: new Date().toISOString(),
  };
  installer.changed("codex");
  assert.deepEqual(
    (await failed).data,
    await json(f, "/api/tool-installations?tool=codex"),
  );
  live.ws.close();
});

test("a tool's version re-push waits for its own probe only", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-version-probe-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Another installed CLI whose --version never answers in time.
  const slow = path.join(dir, "claude");
  await fs.writeFile(slow, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
  const installer = {
    home: dir,
    dataDir: dir,
    detect: () => [
      { id: "codex", installed: true, path: path.join(dir, "missing-codex") },
      { id: "claude", installed: true, path: slow },
    ],
  };
  const started = Date.now();
  const settled = await versionsSettled(installer, "codex");
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(
    settled.map((tool) => tool.id),
    ["codex"],
  );
});
