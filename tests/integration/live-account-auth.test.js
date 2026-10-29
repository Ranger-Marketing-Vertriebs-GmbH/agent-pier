import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { manualTimers } from "../helpers/manual-timers.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import {
  ACCOUNT_AUTH_SAMPLE_MS,
  accountAuthTopic,
  followAccountWrites,
} from "../../server/features/accounts/live-auth-topics.js";

// Task 5.3: `account.auth:<id>`, a CLI account's sign-in state. The CLIs keep their
// credentials where AgentPier cannot watch them (a keychain, the CLI's own store),
// and the state is what `claude auth status` / `codex login status` / `opencode auth
// list` answer. So the server samples it every 30 s while a visible tab watches, one
// CLI run per account for every tab, and reads it at once after a login session of
// the account or a write of the accounts.

const owner = { role: "owner" };

// An AccountAuthStatus stand-in whose answer the test sets; `reads` counts probes.
function authService() {
  const service = {
    states: { work: "authenticated" },
    reads: 0,
    forgotten: [],
    checkedAt: 1,
  };
  service.status = {
    async get(id) {
      if (!Object.hasOwn(service.states, id))
        throw Object.assign(new Error("missing"), { status: 404 });
      service.reads += 1;
      service.checkedAt += 1;
      return { state: service.states[id], checkedAt: service.checkedAt };
    },
    forget(id) {
      service.forgotten.push(id ?? "*");
    },
  };
  return service;
}

function sessionEvents() {
  const listeners = new Set();
  return {
    onSessions(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(sessions) {
      for (const listener of [...listeners]) listener(sessions);
    },
    get size() {
      return listeners.size;
    },
  };
}

function hubOf(t, services) {
  const clock = manualTimers();
  const hub = new LiveHub({ timers: clock.timers });
  t.after(() => hub.close());
  hub.define(accountAuthTopic(services));
  return { clock, hub };
}

const listen = (hub, topic) => {
  const frames = [];
  const stop = hub.subscribe(owner, topic, undefined, (frame) => frames.push(frame));
  return { frames, stop };
};

test("the sign-in state is sampled every 30 s, once for every tab, only while watched", async (t) => {
  assert.equal(ACCOUNT_AUTH_SAMPLE_MS, 30000);
  const service = authService();
  const { clock, hub } = hubOf(t, { accountAuthStatus: service.status });
  const one = listen(hub, "account.auth:work");
  const two = listen(hub, "account.auth:work");
  await clock.advance(0);
  assert.equal(service.reads, 1);
  assert.equal(one.frames[0].type, "snapshot");
  assert.equal(one.frames[0].data.state, "authenticated");
  assert.equal(two.frames[0].data.state, "authenticated");
  // A sample whose state is the same sends nothing; the check time alone is no change.
  await clock.advance(29999);
  assert.equal(service.reads, 1);
  await clock.advance(1);
  assert.equal(service.reads, 2);
  assert.equal(one.frames.length, 1);
  // A signed-out CLI is pushed at the next sample.
  service.states.work = "unauthenticated";
  await clock.advance(30000);
  assert.equal(service.reads, 3);
  assert.equal(one.frames.at(-1).type, "state");
  assert.equal(one.frames.at(-1).data.state, "unauthenticated");
  assert.equal(two.frames.at(-1).data.state, "unauthenticated");
  one.stop();
  two.stop();
  await clock.advance(600000);
  assert.equal(service.reads, 3);
});

test("a login session of the account that starts or ends is read at once", async (t) => {
  const service = authService();
  service.states.other = "unauthenticated";
  const events = sessionEvents();
  const { clock, hub } = hubOf(t, {
    accountAuthStatus: service.status,
    operationsEvents: events,
  });
  const work = listen(hub, "account.auth:work");
  const other = listen(hub, "account.auth:other");
  await clock.advance(0);
  assert.equal(service.reads, 2);
  const login = { id: "login-1", accountId: "work", purpose: "login", status: "running" };
  const chat = { id: "chat-1", accountId: "work", status: "running" };
  // The first list is the baseline; a list without login changes reads nothing.
  events.emit([chat]);
  events.emit([{ ...chat, status: "exited" }]);
  await clock.advance(0);
  assert.equal(service.reads, 2);
  // The login session starts, then ends: each time the account (only it) is read
  // again, past the status cache.
  events.emit([chat, login]);
  await clock.advance(1000);
  assert.equal(service.reads, 3);
  assert.deepEqual(service.forgotten, ["work"]);
  service.states.work = "unauthenticated";
  events.emit([chat]);
  await clock.advance(1000);
  assert.equal(service.reads, 4);
  assert.equal(work.frames.at(-1).data.state, "unauthenticated");
  assert.equal(other.frames.length, 1);
  work.stop();
  other.stop();
  assert.equal(events.size, 0);
});

test("a write of the accounts reads every watched account again", async (t) => {
  const service = authService();
  let saves = 0;
  const accounts = {
    save() {
      saves += 1;
    },
  };
  const services = { accountAuthStatus: service.status, accounts };
  const { clock, hub } = hubOf(t, services);
  followAccountWrites(services, hub);
  listen(hub, "account.auth:work");
  await clock.advance(0);
  assert.equal(service.reads, 1);
  accounts.save();
  await clock.advance(1000);
  assert.equal(saves, 1);
  assert.equal(service.reads, 2);
  assert.deepEqual(service.forgotten, ["*"]);
});

// A fake `claude` whose answer is the file `state` beside it; every run is counted.
async function fakeClaude(f) {
  const directory = path.join(f.root, "fake-claude");
  await fs.mkdir(directory, { recursive: true });
  const binary = path.join(directory, "claude");
  const state = path.join(directory, "state");
  const runs = path.join(directory, "runs");
  await fs.writeFile(state, "true");
  await fs.writeFile(
    binary,
    `#!${process.execPath}\nconst fs=require("node:fs");fs.appendFileSync(${JSON.stringify(runs)},"x");console.log(JSON.stringify({loggedIn:fs.readFileSync(${JSON.stringify(state)},"utf8").trim()==="true"}));`,
    { mode: 0o700 },
  );
  f.application.accountAuthStatus.tools = () => [
    { id: "claude", installed: true, path: binary },
  ];
  return {
    signedIn: (value) => fs.writeFile(state, String(value)),
    runs: async () => (await fs.readFile(runs, "utf8").catch(() => "")).length,
  };
}

async function subscribed(f, topic) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic });
  const first = await live.next((frame) => frame.topic === topic, 5000);
  return { live, first };
}

test("two tabs share one CLI run, and an account change AgentPier makes pushes at once", async (t) => {
  const f = await applicationFixture(t);
  const account = f.application.accounts.create({ name: "Work", tool: "claude" });
  const cli = await fakeClaude(f);
  const topic = `account.auth:${account.id}`;
  const one = await subscribed(f, topic);
  const two = await subscribed(f, topic);
  t.after(() => one.live.ws.close());
  t.after(() => two.live.ws.close());
  for (const { first } of [one, two]) {
    assert.equal(first.type, "snapshot");
    assert.equal(first.data.state, "authenticated");
  }
  assert.equal(await cli.runs(), 1);
  // The REST route answers the same value, from the same probe.
  const rest = await (await f.request(`/api/accounts/${account.id}/auth-status`)).json();
  assert.equal(rest.state, "authenticated");
  assert.equal(await cli.runs(), 1);
  // Signed out elsewhere, then renamed in AgentPier: the write reads it again now,
  // not after the CLI status cache or the next sample.
  await cli.signedIn(false);
  const renamed = await f.request(`/api/accounts/${account.id}`, {
    method: "PATCH",
    body: { name: "Renamed" },
  });
  assert.equal(renamed.status, 200);
  const pushed = await one.live.next(
    (frame) => frame.topic === topic && frame.type === "state",
    3000,
  );
  assert.equal(pushed.data.state, "unauthenticated");
  await two.live.next((frame) => frame.topic === topic && frame.type === "state", 3000);
  await delay(100);
  assert.equal(await cli.runs(), 2);
});

test("an unknown account is a refusal the route gives, not an unknown topic", async (t) => {
  const f = await applicationFixture(t);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => (console.error = original));
  const { live, first } = await subscribed(f, "account.auth:missing");
  t.after(() => live.ws.close());
  assert.equal(first.type, "error");
  assert.notEqual(first.code, "unknown-topic");
  assert.deepEqual(
    errors.filter((line) => line.includes("account.auth")),
    [],
  );
  for (const topic of [
    "account.auth",
    "account.auth:bad id",
    `account.auth:${"x".repeat(101)}`,
  ]) {
    live.send({ op: "sub", topic });
    assert.equal(
      (await live.next((frame) => frame.topic === topic.slice(0, 200))).code,
      "unknown-topic",
    );
  }
});

// A fake `claude` that answers the `state` file as read at its start, after the
// delay in the `delay` file; every start and end is logged with the time.
async function slowClaude(f) {
  const directory = path.join(f.root, "slow-claude");
  await fs.mkdir(directory, { recursive: true });
  const file = (name) => JSON.stringify(path.join(directory, name));
  const binary = path.join(directory, "claude");
  await fs.writeFile(path.join(directory, "state"), "true");
  await fs.writeFile(path.join(directory, "delay"), "0");
  await fs.writeFile(
    binary,
    `#!${process.execPath}
const fs=require("node:fs");
const state=fs.readFileSync(${file("state")},"utf8").trim()==="true";
const delay=Number(fs.readFileSync(${file("delay")},"utf8"));
fs.appendFileSync(${file("log")},"start\\n");
setTimeout(()=>{fs.appendFileSync(${file("log")},"end\\n");console.log(JSON.stringify({loggedIn:state}));},delay);`,
    { mode: 0o700 },
  );
  f.application.accountAuthStatus.tools = () => [
    { id: "claude", installed: true, path: binary },
  ];
  const set = (name, value) => fs.writeFile(path.join(directory, name), String(value));
  return {
    signedIn: (value) => set("state", value),
    delay: (ms) => set("delay", ms),
    log: async () =>
      (await fs.readFile(path.join(directory, "log"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean),
  };
}

test("a probe running when the state is forgotten never fills the cache", async (t) => {
  const f = await applicationFixture(t);
  const account = f.application.accounts.create({ name: "Work", tool: "claude" });
  const cli = await slowClaude(f);
  const status = f.application.accountAuthStatus;
  // The old probe reads "signed in" and answers late.
  await cli.delay(1500);
  const old = status.get(account.id);
  // Its CLI has read the state once it logged its start.
  while (!(await cli.log()).includes("start")) await delay(10);
  // Signed out meanwhile (a login session ended): forgotten while the probe runs.
  await cli.signedIn(false);
  await cli.delay(0);
  status.forget(account.id);
  // The next read does not join the old probe: it probes anew.
  assert.equal((await status.get(account.id)).state, "unauthenticated");
  assert.equal((await old).state, "authenticated");
  // The old answer arrived last but was not cached.
  assert.equal((await status.get(account.id)).state, "unauthenticated");
  assert.equal((await cli.log()).filter((line) => line === "start").length, 2);
});

test("at most three CLI status probes run at once across accounts", async (t) => {
  const f = await applicationFixture(t);
  const accounts = Array.from({ length: 6 }, (_, index) =>
    f.application.accounts.create({ name: `Work ${index}`, tool: "claude" }),
  );
  const cli = await slowClaude(f);
  await cli.delay(200);
  const answers = await Promise.all(
    accounts.map((account) => f.application.accountAuthStatus.get(account.id)),
  );
  assert.deepEqual(
    answers.map((answer) => answer.state),
    accounts.map(() => "authenticated"),
  );
  let running = 0,
    most = 0;
  for (const line of await cli.log()) {
    running += line === "start" ? 1 : -1;
    most = Math.max(most, running);
  }
  assert.equal(most, 3);
});

test("forgetting one account leaves another account's running probe cached", async (t) => {
  const f = await applicationFixture(t);
  const work = f.application.accounts.create({ name: "Work", tool: "claude" });
  const home = f.application.accounts.create({ name: "Home", tool: "claude" });
  const cli = await slowClaude(f);
  const status = f.application.accountAuthStatus;
  await cli.delay(500);
  const running = status.get(home.id);
  while (!(await cli.log()).includes("start")) await delay(10);
  status.forget(work.id);
  assert.equal((await running).state, "authenticated");
  // Its answer filled the cache: the next read runs no CLI.
  assert.equal((await status.get(home.id)).state, "authenticated");
  assert.equal((await cli.log()).filter((line) => line === "start").length, 1);
});
