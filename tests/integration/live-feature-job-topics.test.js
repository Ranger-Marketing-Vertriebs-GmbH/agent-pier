import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { manualTimers } from "../helpers/manual-timers.js";
import { subscribe, until } from "../helpers/live-hub-subscriber.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { defineJobTopic } from "../../server/features/live/job-topics.js";
import { reportLiveError } from "../../server/application/live-wiring.js";
import { PackageJobs } from "../../server/features/mcp-packages/install-jobs.js";
import {
  mcpPackageJob,
  watchPackageJobs,
} from "../../server/features/mcp-packages/live-topics.js";
import {
  pluginJobChanged,
  pluginsJob,
} from "../../server/features/plugins/live-topics.js";
import {
  SSH_TOOLS_SAMPLE_MS,
  sshToolsChanged,
  sshToolsJob,
} from "../../server/features/ssh/live-topics.js";
import { SshSessions } from "../../server/features/ssh/ssh-sessions.js";
import {
  chatgptLoginChanged,
  chatgptLoginJob,
} from "../../server/features/assistants/live-login-topics.js";
import { AssistantAccountLogin } from "../../server/features/assistants/model-account-login.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { PluginStore } from "../../server/features/plugins/plugin-store.js";
import { writePrivate } from "../../server/lib/storage.js";

// The job kinds of Task 3.2 (mcp-package, plugins, ssh-tools, chatgpt-login): each
// source signals its writes, a job's end always reads differently, and a failing
// listener is logged, never thrown.

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

const fastHub = (t, options = {}) => {
  const hub = new LiveHub({ debounceMs: 5, maxWaitMs: 20, ...options });
  t.after(() => hub.close());
  return hub;
};

test("package jobs signal their start, every log line and their end", async () => {
  const jobs = new PackageJobs();
  const signals = [];
  jobs.onChange = (id) => signals.push([id, jobs.get(id).state, jobs.get(id).log]);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const started = jobs.run("s1", { kind: "install" }, async (log) => {
    log("fetching");
    await gate;
  });
  assert.equal(started.state, "running");
  assert.match(started.startedAt, /^\d{4}-\d\d-\d\dT/);
  await until(() => signals.length >= 2);
  release();
  await jobs.idle();
  assert.deepEqual(signals, [
    ["s1", "running", ""],
    ["s1", "running", "fetching\n"],
    ["s1", "done", "fetching\n"],
  ]);
  // A second job that ends like the first still reads differently (its startedAt).
  const first = jobs.get("s1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  jobs.run("s1", { kind: "install" }, async (log) => log("fetching"));
  await jobs.idle();
  const second = jobs.get("s1");
  assert.equal(second.state, first.state);
  assert.equal(second.log, first.log);
  assert.notEqual(second.startedAt, first.startedAt);
});

test("a failing package listener is logged and the job still ends", async (t) => {
  const errors = errorsOf(t);
  const jobs = new PackageJobs();
  jobs.onChange = () => {
    throw new Error("listener");
  };
  jobs.run("s1", { kind: "install" }, async (log) => log("step"));
  await jobs.idle();
  assert.equal(jobs.get("s1").state, "done");
  assert.ok(errors.some((line) => /announce an MCP package job/.test(line)));
});

test("job.mcp-package pushes the package status on each job and record write", async (t) => {
  const hub = fastHub(t);
  const jobs = new PackageJobs();
  const records = {};
  const packages = {
    jobs,
    records,
    status: (id) => ({ source: null, job: jobs.get(id) }),
  };
  const services = { mcpPackages: packages, live: hub };
  defineJobTopic(hub, mcpPackageJob(services));
  watchPackageJobs(services, packages);
  assert.equal(typeof records.onChange, "function");
  const live = subscribe(hub, "job.mcp-package:s1");
  assert.equal((await live.next()).data.job, null);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  jobs.run("s1", { kind: "update" }, () => gate);
  const running = await live.next((frame) => frame.data?.job?.state === "running");
  assert.equal(running.data.job.kind, "update");
  release();
  const ended = await live.next((frame) => frame.data?.job?.state === "done");
  assert.equal(ended.data.job.startedAt, running.data.job.startedAt);
  // A record write (a detach, a switch) is pushed although no job runs.
  packages.status = () => ({ source: { status: "ready" }, job: jobs.get("s1") });
  records.onChange("s1");
  assert.equal(
    (await live.next((frame) => frame.data?.source)).data.source.status,
    "ready",
  );
  // Another server's write does not reach this topic.
  const before = live.frames.length;
  records.onChange("s2");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(live.frames.length, before);
});

test("job.mcp-package refusals are expected and not logged", async (t) => {
  const errors = errorsOf(t);
  const hub = fastHub(t, { onError: reportLiveError });
  const missing = Object.assign(new Error("gone"), { status: 404 });
  defineJobTopic(hub, mcpPackageJob({ mcpPackages: null }));
  const unavailable = subscribe(hub, "job.mcp-package:s1");
  assert.equal((await unavailable.next()).type, "error");
  const other = fastHub(t, { onError: reportLiveError });
  defineJobTopic(
    other,
    mcpPackageJob({
      mcpPackages: {
        status: () => {
          throw missing;
        },
      },
    }),
  );
  assert.equal((await subscribe(other, "job.mcp-package:gone").next()).type, "error");
  assert.deepEqual(errors, []);
});

// A PluginStore over a fake CLI whose plugin change waits for `gate`.
function pluginStore(t, gate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-plugin-topic-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home });
  const run = async (_command, args) => {
    if (args.includes("marketplace") && args.includes("list")) return "[]";
    if (args.includes("list"))
      return JSON.stringify({
        installed: [],
        available: [{ pluginId: "other@fixture", name: "other" }],
      });
    await gate;
    return "{}";
  };
  const store = new PluginStore({ accounts, home, resolveTool: (tool) => tool, run });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { store, account: accounts.create({ name: "Fixture", tool: "claude" }) };
}

test("job.plugins pushes busy while a plugin change runs and its end", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { store, account } = pluginStore(t, gate);
  const hub = fastHub(t);
  defineJobTopic(hub, pluginsJob({ plugins: store }));
  store.onChange = () => pluginJobChanged(hub);
  const live = subscribe(hub, `job.plugins:${account.id}`);
  const idle = await live.next();
  assert.equal(idle.data.busy, false);
  assert.deepEqual(idle.data, await store.list(account.id));
  const change = store.mutate(account.id, {
    action: "install",
    pluginId: "other@fixture",
  });
  assert.equal(
    (await live.next((frame) => frame.data?.busy === true)).data.catalog[0].id,
    "other@fixture",
  );
  release();
  await change;
  const ended = await live.next((frame) => frame.data?.busy === false);
  assert.deepEqual(ended.data, await store.list(account.id));
});

test("a failing plugin listener is logged and the change still runs", async (t) => {
  const errors = errorsOf(t);
  const { store, account } = pluginStore(t, Promise.resolve());
  store.onChange = () => {
    throw new Error("listener");
  };
  await store.mutate(account.id, { action: "install", pluginId: "other@fixture" });
  assert.equal(store.isBusy(account.id), false);
  assert.equal(errors.filter((line) => /plugin change/.test(line)).length, 2);
});

test("job.ssh-tools samples starting tools until they are ready", async (t) => {
  const clock = manualTimers();
  const hub = new LiveHub({ timers: clock.timers });
  t.after(() => hub.close());
  let state = "starting",
    reads = 0;
  const services = {
    sessions: { get: async (id) => ({ id }) },
    sshSessions: { get: async () => ({ accesses: [], assignedIds: [], commands: [] }) },
    sshIntegration: {
      status: () => {
        reads += 1;
        return { state, generation: "g1" };
      },
    },
  };
  defineJobTopic(hub, sshToolsJob(services));
  const live = subscribe(hub, "job.ssh-tools:session-one");
  await clock.advance(0);
  assert.equal(live.frames[0].data.tools.state, "starting");
  await clock.advance(SSH_TOOLS_SAMPLE_MS);
  assert.equal(reads, 2);
  state = "ready";
  await clock.advance(SSH_TOOLS_SAMPLE_MS);
  assert.equal(live.frames.at(-1).data.tools.state, "ready");
  const after = reads;
  await clock.advance(SSH_TOOLS_SAMPLE_MS * 5);
  assert.equal(reads, after);
  // An assignment change signals the topic, also once the tools are ready.
  sshToolsChanged(hub, "session-one");
  await clock.advance(1000);
  assert.equal(reads, after + 1);
  sshToolsChanged(hub, null);
  await clock.advance(1000);
  assert.equal(reads, after + 2);
  live.stop();
});

test("SSH assignments signal their session, a revoked host every session", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-ssh-topic-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const accesses = [{ id: "server-one", name: "Lab", host: "192.0.2.1" }];
  const store = { list: () => accesses, get: (id) => accesses.find((a) => a.id === id) };
  const session = {
    id: "session-one",
    accountId: "local-codex",
    tool: "codex",
    createdAt: "2026-09-08",
    status: "running",
  };
  writePrivate(path.join(dataDir, "sessions", `${session.id}.json`), session);
  const grants = new SshSessions({ dataDir, store });
  const signals = [];
  grants.onChange = (id) => signals.push(id);
  await grants.set(session, ["server-one"]);
  grants.revokeAccess("server-one");
  await grants.set(session, []);
  assert.deepEqual(signals, ["session-one", null, "session-one"]);
});

// An AssistantAccountLogin whose Gateway answers `steps`, then waits.
function loginFixture(steps) {
  const client = Object.assign(new EventEmitter(), { ready: true });
  client.call = async (method, params) => {
    if (method === "models.authLogin") return { sessionId: params.sessionId };
    if (method === "wizard.cancel") return { status: "cancelled" };
    return steps.length ? steps.shift() : new Promise(() => {});
  };
  return new AssistantAccountLogin({
    runtime: { client },
    accounts: { list: async () => [] },
    warn: () => {},
  });
}

const deviceStep = {
  done: false,
  step: {
    id: "device",
    type: "progress",
    externalUrl: "https://auth.openai.com/codex/device",
    deviceCode: { code: "ABCD-EFGHI", expiresInMinutes: 15 },
    access_token: "private",
  },
};

test("job.chatgpt-login pushes each change of the attempt and nothing secret", async (t) => {
  // The sign-in ends only once the code was pushed: no reliance on how long the
  // login waits between wizard steps.
  let finish;
  const finished = new Promise((resolve) => (finish = resolve));
  const login = loginFixture([deviceStep, finished]);
  const hub = fastHub(t);
  const services = { assistantModelLogin: login };
  defineJobTopic(hub, chatgptLoginJob(services));
  login.onChange = () => chatgptLoginChanged(hub);
  const live = subscribe(hub, "job.chatgpt-login:current");
  assert.equal((await live.next()).type, "error");
  const attempt = login.start();
  const awaiting = await live.next((frame) => frame.data?.status === "awaiting_user");
  assert.equal(awaiting.data.id, attempt.id);
  assert.equal(awaiting.data.code, "ABCD-EFGHI");
  assert.ok(!JSON.stringify(awaiting.data).includes("private"));
  // The whole payload is the route's: a field added to status() must show here.
  assert.deepEqual(awaiting.data, login.status(attempt.id));
  assert.deepEqual(Object.keys(awaiting.data).sort(), [
    "code",
    "expiresAt",
    "id",
    "status",
    "url",
  ]);
  finish({ done: true, status: "done" });
  const done = await live.next((frame) => frame.data?.status === "completed");
  assert.deepEqual(done.data, login.status(attempt.id));
  // A new attempt is pushed under its own id.
  const next = login.start();
  assert.notEqual(next.id, attempt.id);
  await login.cancel(next.id);
  const cancelled = await live.next((frame) => frame.data?.status === "cancelled");
  assert.equal(cancelled.data.id, next.id);
});

test("job.chatgpt-login refusals are expected and a failing listener is logged", async (t) => {
  const errors = errorsOf(t);
  const hub = fastHub(t, { onError: reportLiveError });
  const services = { assistantModelLogin: null };
  defineJobTopic(hub, chatgptLoginJob(services));
  assert.equal((await subscribe(hub, "job.chatgpt-login:current").next()).type, "error");
  const login = loginFixture([]);
  login.onChange = () => {
    throw new Error("listener");
  };
  services.assistantModelLogin = login;
  const attempt = login.start();
  assert.equal(attempt.status, "starting");
  await login.close();
  assert.equal(login.status(attempt.id).status, "cancelled");
  assert.ok(errors.length >= 2);
  assert.ok(errors.every((line) => /ChatGPT sign-in/.test(line)));
});

test("job.chatgpt-login follows the agent services being switched on and off", async (t) => {
  const hub = fastHub(t);
  const events = new EventEmitter();
  const services = { assistantModelLogin: null, assistantFeature: { events } };
  defineJobTopic(hub, chatgptLoginJob(services));
  const live = subscribe(hub, "job.chatgpt-login:current");
  assert.equal((await live.next()).type, "error");
  const login = loginFixture([deviceStep]);
  login.start();
  services.assistantModelLogin = login;
  events.emit("started");
  assert.equal((await live.next((frame) => frame.data)).data.status, "awaiting_user");
  live.stop();
  assert.equal(events.listenerCount("started"), 0);
  await login.close();
});

test("the new job kinds are the owner's alone", (t) => {
  const hub = fastHub(t);
  defineJobTopic(hub, mcpPackageJob({}));
  defineJobTopic(hub, pluginsJob({}));
  defineJobTopic(hub, sshToolsJob({}));
  defineJobTopic(hub, chatgptLoginJob({}));
  for (const topic of [
    "job.mcp-package:s1",
    "job.plugins:local-codex",
    "job.ssh-tools:session-one",
    "job.chatgpt-login:current",
  ]) {
    assert.equal(hub.resolve(user, topic), null, topic);
    assert.equal(hub.resolve(null, topic), null, topic);
    assert.ok(hub.resolve(owner, topic), topic);
  }
  assert.equal(hub.resolve(owner, "job.chatgpt-login:other"), null);
  assert.equal(hub.resolve(owner, "job.ssh-tools:a/b"), null);
});
