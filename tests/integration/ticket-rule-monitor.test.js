// TicketRuleMonitor: polling label rules, appending their tickets once, and reporting
// a failing rule once per error kind. Fake trackers, fake time and temp dirs only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketRuleStore } from "../../server/features/tickets/rule-store.js";
import { TicketRuleMonitor } from "../../server/features/tickets/rule-monitor.js";
import {
  SESSION,
  labelledIssue,
  planeItem,
  ruleInput,
  ruleMonitorFixture,
} from "../helpers/rule-monitor-fixture.js";

const addStart = (f, key) =>
  f.ticketStore.addStart({
    projectId: "p1",
    source: "github",
    key,
    title: "Started",
    url: "",
    kind: "session",
    targetId: "s0",
    writeBack: { state: "done" },
  });

test("appends new labelled issues oldest first with a rule origin", async (t) => {
  const f = await ruleMonitorFixture(t, {
    issues: [
      labelledIssue(14, "agent"),
      labelledIssue(12, "agent"),
      labelledIssue(15, "bug"),
      labelledIssue(13, "agent", "bug"),
    ],
  });
  const rule = f.rules.create("p1", ruleInput());
  await f.monitor().run();
  assert.deepEqual(f.keys(), ["acme/app#12", "acme/app#13", "acme/app#14"]);
  for (const item of f.items()) {
    assert.deepEqual(item.origin, { kind: "rule", ruleId: rule.id });
    assert.equal(item.kind, "session");
    assert.deepEqual(item.options, { allowMerge: false, session: SESSION });
  }
  assert.equal(f.items()[0].title, "Issue 12");
  const status = f.status(rule.id);
  assert.equal(status.error, null);
  assert.equal(status.notified, null);
  assert.ok(status.checkedAt > 0);
  assert.equal(f.rules.pickupCount("p1", rule.id), 3);
  assert.deepEqual(f.notified, []);
});

test("label match ignores case", async (t) => {
  const f = await ruleMonitorFixture(t, { issues: [labelledIssue(3, " AGENT ")] });
  f.rules.create("p1", ruleInput({ label: "Agent" }));
  await f.monitor().run();
  assert.deepEqual(f.keys(), ["acme/app#3"]);
});

test("a second pass appends only new tickets", async (t) => {
  const issues = [labelledIssue(1, "agent")];
  const f = await ruleMonitorFixture(t, { issues });
  f.rules.create("p1", ruleInput());
  const monitor = f.monitor();
  await monitor.run();
  issues.push(labelledIssue(2, "agent"));
  await monitor.run();
  await monitor.run();
  assert.deepEqual(f.keys(), ["acme/app#1", "acme/app#2"]);
});

test("label kept after done does not restart", async (t) => {
  const f = await ruleMonitorFixture(t, { issues: [labelledIssue(1, "agent")] });
  f.rules.create("p1", ruleInput());
  const monitor = f.monitor();
  await monitor.run();
  const [item] = f.items();
  f.store.patch("p1", item.id, { state: "done", doneBy: "owner", doneAt: 5 });
  await monitor.run();
  assert.equal(f.items().length, 1);
  assert.equal(f.items()[0].state, "done");
});

test("pruned queue and start records still dedupe by pickup", async (t) => {
  const f = await ruleMonitorFixture(t, {
    issues: [labelledIssue(1, "agent"), labelledIssue(2, "agent")],
  });
  // #2 was started by hand before the rule existed.
  const start = addStart(f, "acme/app#2");
  const rule = f.rules.create("p1", ruleInput());
  const monitor = f.monitor();
  await monitor.run();
  assert.deepEqual(f.keys(), ["acme/app#1"]);
  assert.equal(f.rules.picked("p1", "github", "acme/app#2").itemId, start.id);
  // The queue item is done and pruned, the start record pruned: only pickups remain.
  const [item] = f.items();
  f.store.patch("p1", item.id, { state: "done", doneBy: "owner", doneAt: 5 });
  f.store.remove("p1", item.id);
  f.ticketStore.startRecords = [];
  f.ticketStore.save();
  await monitor.run();
  assert.deepEqual(f.items(), []);
  assert.equal(f.rules.pickupCount("p1", rule.id), 2);
});

test("two rules matching one ticket append it once", async (t) => {
  const f = await ruleMonitorFixture(t, { issues: [labelledIssue(1, "agent", "ai")] });
  const agent = f.rules.create("p1", ruleInput());
  f.rules.create("p1", ruleInput({ label: "ai" }));
  await f.monitor().run();
  assert.deepEqual(f.keys(), ["acme/app#1"]);
  assert.deepEqual(f.items()[0].origin, { kind: "rule", ruleId: agent.id });
  assert.equal(f.listCalls().github, 1);
});

test("paused rules are not polled", async (t) => {
  const f = await ruleMonitorFixture(t, { issues: [labelledIssue(1, "agent")] });
  const rule = f.rules.create("p1", ruleInput({ paused: true }));
  await f.monitor().run();
  assert.equal(f.github.calls.length, 0);
  assert.deepEqual(f.items(), []);
  assert.equal(f.status(rule.id).checkedAt, null);
});

test("one list call per source per project for several rules", async (t) => {
  const f = await ruleMonitorFixture(t, {
    issues: [labelledIssue(1, "agent"), labelledIssue(2, "bug")],
    planeItems: [planeItem(4, ["l-agent"])],
  });
  await f.linkPlane();
  for (const label of ["agent", "bug", "ai"]) f.rules.create("p1", ruleInput({ label }));
  f.rules.create("p1", ruleInput({ source: "plane" }));
  f.rules.create("p1", ruleInput({ source: "plane", label: "bug" }));
  await f.monitor().run();
  assert.deepEqual(f.listCalls(), { github: 1, plane: 1 });
  assert.deepEqual(f.keys(), ["acme/app#1", "acme/app#2", "AP-4"]);
});

test("unconnected source sets notConnected without a request", async (t) => {
  const f = await ruleMonitorFixture(t);
  // No Plane link for p1.
  const plane = f.rules.create("p1", ruleInput({ source: "plane" }));
  const gone = f.rules.create("p9", ruleInput());
  await f.monitor().run();
  assert.equal(f.status(plane.id).error.code, "notConnected");
  assert.equal(f.rules.rule("p9", gone.id).status.error.code, "projectGone");
  assert.equal(f.plane.calls.length, 0);
  assert.equal(f.github.calls.length, 0);
  assert.deepEqual(
    f.notified.map((n) => n.projectId),
    ["p1", "p9"],
  );
});

test("a repo without GitHub access sets notConnected for every rule", async (t) => {
  const f = await ruleMonitorFixture(t, { remote: "git@gitlab.com:x/y.git" });
  await f.linkPlane();
  const github = f.rules.create("p1", ruleInput());
  const plane = f.rules.create("p1", ruleInput({ source: "plane" }));
  await f.monitor().run();
  assert.equal(f.status(github.id).error.code, "notConnected");
  // A Plane rule feeds a sequence, which needs GitHub too.
  assert.equal(f.status(plane.id).error.code, "notConnected");
  assert.equal(f.listCalls().plane, 0);
});

test("unreachable source sets the code on the rule and pushes once per error kind until it clears", async (t) => {
  const f = await ruleMonitorFixture(t, { issues: [labelledIssue(1, "agent")] });
  const rule = f.rules.create("p1", ruleInput());
  const monitor = f.monitor();
  f.net.down = true;
  await monitor.run();
  const since = f.status(rule.id).error.since;
  await monitor.run();
  await monitor.run();
  assert.equal(f.notified.length, 1);
  assert.deepEqual(f.notified[0], {
    kind: "ticket-rule-failed",
    eventId: f.notified[0].eventId,
    projectId: "p1",
  });
  assert.match(f.notified[0].eventId, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.status(rule.id).error, { code: "unreachable", since });
  assert.equal(f.status(rule.id).notified, "unreachable");
  assert.deepEqual(f.logs, ["AgentPier could not poll a label rule: unreachable"]);
  assert.deepEqual(f.items(), []);
  // Recovery clears the error and the notice.
  f.net.down = false;
  await monitor.run();
  assert.equal(f.status(rule.id).error, null);
  assert.equal(f.status(rule.id).notified, null);
  assert.deepEqual(f.keys(), ["acme/app#1"]);
  // The same kind after recovery pushes once more, under a new event id.
  f.net.down = true;
  await monitor.run();
  await monitor.run();
  assert.equal(f.notified.length, 2);
  assert.notEqual(f.notified[1].eventId, f.notified[0].eventId);
  // Another kind pushes once too.
  f.net.down = false;
  f.githubFailures["GET /repos/acme/app/issues"] = 401;
  await monitor.run();
  await monitor.run();
  assert.equal(f.notified.length, 3);
  assert.equal(f.status(rule.id).error.code, "unauthorized");
  for (const line of f.logs) assert.doesNotMatch(line, /gh-token|http|acme/);
});

test("an owner edit during the push is not overwritten by the old error", async (t) => {
  const f = await ruleMonitorFixture(t);
  f.net.down = true;
  const moved = f.rules.create("p1", ruleInput());
  let edit;
  const notifications = {
    notify: async (input) => {
      f.notified.push(input);
      edit();
    },
  };
  // Relabelled while the push is sent: the store reset its status, which stays.
  edit = () => f.rules.update("p1", moved.id, ruleInput({ label: "ready" }));
  await f.monitor({ notifications }).run();
  assert.equal(f.notified.length, 1);
  assert.deepEqual(f.status(moved.id), { checkedAt: null, error: null, notified: null });
  // An edit that keeps source and label keeps the status, so the error is written.
  const kept = f.rules.create("p1", ruleInput({ label: "other" }));
  edit = () =>
    f.rules.update(
      "p1",
      kept.id,
      ruleInput({ label: "other", options: { allowMerge: true, session: SESSION } }),
    );
  f.rules.remove("p1", moved.id);
  await f.monitor({ notifications }).run();
  assert.equal(f.status(kept.id).error.code, "unreachable");
  assert.equal(f.status(kept.id).notified, "unreachable");
});

test("label gone sets labelGone", async (t) => {
  const f = await ruleMonitorFixture(t, {
    issues: [labelledIssue(1, "bug")],
    githubLabels: ["bug"],
  });
  const rule = f.rules.create("p1", ruleInput());
  const kept = f.rules.create("p1", ruleInput({ label: "Bug" }));
  f.rules.create("p1", ruleInput({ label: "idle" }));
  await f.monitor().run();
  assert.equal(f.status(rule.id).error.code, "labelGone");
  assert.equal(f.status(kept.id).error, null);
  assert.equal(
    f.github.calls.filter((c) => c.path === "/repos/acme/app/labels/agent").length,
    1,
  );
});

test("a label that exists without tickets is fine", async (t) => {
  const f = await ruleMonitorFixture(t, { githubLabels: ["agent"] });
  const rule = f.rules.create("p1", ruleInput());
  await f.monitor().run();
  assert.equal(f.status(rule.id).error, null);
  assert.ok(f.status(rule.id).checkedAt > 0);
});

test("a read cut off at the cap succeeds flagged capped, never labelGone", async (t) => {
  // 350 open issues: the read stops at 300, so #340 with the label is never seen.
  const issues = Array.from({ length: 350 }, (_, i) =>
    i + 1 === 340 ? labelledIssue(340, "agent") : labelledIssue(i + 1),
  );
  const f = await ruleMonitorFixture(t, { issues });
  const rule = f.rules.create("p1", ruleInput());
  await f.monitor().run();
  assert.equal(f.status(rule.id).error, null);
  assert.equal(f.status(rule.id).capped, true);
  assert.ok(f.status(rule.id).checkedAt > 0);
  const small = await ruleMonitorFixture(t, { issues: [labelledIssue(1, "agent")] });
  const other = small.rules.create("p1", ruleInput());
  await small.monitor().run();
  assert.equal(small.status(other.id).capped, undefined);
});

test("queue full sets queueFull and appends the rest next pass", async (t) => {
  const f = await ruleMonitorFixture(t, {
    issues: [1, 2, 3].map((n) => labelledIssue(n, "agent")),
  });
  f.store.append(
    "p1",
    f.projectPath,
    Array.from({ length: 199 }, (_, i) => ({
      source: "github",
      key: `acme/app#${i + 100}`,
      title: "Other",
      url: "",
      kind: "session",
      options: { allowMerge: false, session: SESSION },
    })),
  );
  const rule = f.rules.create("p1", ruleInput());
  const monitor = f.monitor();
  await monitor.run();
  assert.equal(f.status(rule.id).error.code, "queueFull");
  assert.equal(f.notified.length, 1);
  assert.equal(f.keys().at(-1), "acme/app#1");
  for (const item of f.items().slice(0, 2)) f.store.remove("p1", item.id);
  await monitor.run();
  assert.deepEqual(f.keys().slice(-3), ["acme/app#1", "acme/app#2", "acme/app#3"]);
  assert.equal(f.status(rule.id).error, null);
});

test("plane rule appends work items with a rule origin", async (t) => {
  const f = await ruleMonitorFixture(t, {
    planeItems: [planeItem(7, ["l-agent"]), planeItem(5, ["l-agent"]), planeItem(6)],
  });
  await f.linkPlane();
  const rule = f.rules.create("p1", ruleInput({ source: "plane" }));
  await f.monitor().run();
  assert.deepEqual(f.keys(), ["AP-5", "AP-7"]);
  for (const item of f.items()) {
    assert.equal(item.source, "plane");
    assert.deepEqual(item.origin, { kind: "rule", ruleId: rule.id });
  }
  assert.equal(f.status(rule.id).error, null);
});

test("rule keys match the spelling of manual starts", async (t) => {
  const f = await ruleMonitorFixture(t, {
    issues: [labelledIssue(5, "agent"), labelledIssue(6, "agent")],
    remote: "https://github.com/Acme/App.git",
  });
  // Queued by hand in another spelling: canonicalKey makes it "Acme/App#5".
  await f.sequences.add("p1", {
    tickets: [{ source: "github", key: "acme/app#5" }],
    kind: "session",
    allowMerge: false,
    session: SESSION,
  });
  const rule = f.rules.create("p1", ruleInput());
  await f.monitor().run();
  assert.deepEqual(f.keys(), ["Acme/App#5", "Acme/App#6"]);
  assert.equal(f.items()[0].origin.kind, "manual");
  assert.equal(f.rules.picked("p1", "github", "Acme/App#5").ruleId, rule.id);
  assert.equal(f.rules.picked("p1", "github", "Acme/App#6").ruleId, rule.id);
});

/** A monitor over stub tickets whose GitHub list blocks until released. */
function blockingMonitor(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-rule-block-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rules = new TicketRuleStore({ dataDir: dir });
  const rule = rules.create("p1", ruleInput());
  const reads = [];
  const tickets = {
    resolveProject: (id) => ({ id, path: dir }),
    accesses: async () => ({ link: {}, github: { owner: "acme", repo: "app" } }),
    sources: {
      github: {
        list: (_access, { signal }) =>
          new Promise((resolve, reject) => {
            const read = { signal, release: () => resolve({ tickets: [], labels: [] }) };
            if (!options.ignoreAbort)
              signal.addEventListener("abort", () => reject(new Error("aborted")));
            reads.push(read);
          }),
        hasLabel: async () => true,
      },
    },
  };
  const monitor = new TicketRuleMonitor({
    rules,
    tickets,
    sequences: { appendFromRule: async () => ({ added: [], full: false }) },
    notifications: { notify: async () => {} },
    log: () => {},
    ...options,
  });
  t.after(() => monitor.close());
  return { monitor, reads, rules, rule };
}
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("start waits initialDelayMs, then every intervalMs, never overlapping", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { monitor, reads } = blockingMonitor(t, {
    intervalMs: 600_000,
    initialDelayMs: 30_000,
  });
  monitor.start();
  monitor.start();
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(reads.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(reads.length, 1);
  // The interval fires while the first pass still reads: it joins, never overlaps.
  t.mock.timers.tick(600_000);
  await flush();
  assert.equal(reads.length, 1);
  reads[0].release();
  await flush();
  t.mock.timers.tick(600_000);
  await flush();
  assert.equal(reads.length, 2);
  reads[1].release();
  await flush();
  assert.equal(monitor.pending, null);
});

test("an interval of 0 turns polling off", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { monitor, reads } = blockingMonitor(t, { intervalMs: 0, initialDelayMs: 0 });
  monitor.start();
  monitor.request();
  t.mock.timers.tick(10_000_000);
  await flush();
  assert.equal(reads.length, 0);
});

test("close aborts a pending read within 1 s", async (t) => {
  const { monitor, reads, rules, rule } = blockingMonitor(t);
  const pass = monitor.run();
  await flush();
  assert.equal(reads.length, 1);
  const started = Date.now();
  await monitor.close();
  assert.ok(Date.now() - started < 500);
  assert.equal(reads[0].signal.aborted, true);
  await pass;
  // Aborted by shutdown: no error on the rule.
  assert.deepEqual(rules.rule("p1", rule.id).status, {
    checkedAt: null,
    error: null,
    notified: null,
  });
  monitor.request();
  await flush();
  assert.equal(reads.length, 1);
});

test("close gives up waiting on a read that ignores the abort after 1 s", async (t) => {
  const { monitor, reads } = blockingMonitor(t, { ignoreAbort: true });
  monitor.run();
  await flush();
  const started = Date.now();
  await monitor.close();
  const waited = Date.now() - started;
  assert.ok(waited >= 900 && waited < 1500, `waited ${waited} ms`);
  reads[0].release();
});

test("request during a pass runs one more pass after it", async (t) => {
  const { monitor, reads } = blockingMonitor(t);
  monitor.request();
  await flush();
  assert.equal(reads.length, 1);
  monitor.request();
  monitor.request();
  reads[0].release();
  await flush();
  assert.equal(reads.length, 2);
  reads[1].release();
  await flush();
  assert.equal(reads.length, 2);
  assert.equal(monitor.pending, null);
});
