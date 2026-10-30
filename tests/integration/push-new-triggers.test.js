import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OperationsEvents } from "../../server/application/operations-events.js";
import {
  ReleaseFailureEvents,
  releaseFailureWindowMs,
  updateAvailable,
} from "../../server/application/release-events.js";
import { codexActivityTracker } from "../../server/features/requests/codex-activity.js";
import { nativePushValue } from "../../server/features/requests/native-push.js";
import { hookPush } from "../../server/features/sessions/native-session-binding.js";
import { pushEvent } from "../../server/features/notifications/push-validation.js";

// The notification service's surface the emitters use; every notice must validate.
function fakeNotifications() {
  const sent = [],
    observations = new Map();
  return {
    sent,
    status: () => ({ subscriptions: [{}] }),
    observation: (key) => observations.get(key),
    observe: (key, value) => observations.set(key, value),
    notify: async (input) => {
      pushEvent(input);
      sent.push(input);
    },
  };
}

test("an update notifies once per version, never while up to date", async () => {
  const n = fakeNotifications();
  await updateAvailable(n, { version: "2.13.0", upToDate: true });
  await updateAvailable(n, { version: "2.13.0", upToDate: false });
  await updateAvailable(n, { version: "2.13.0", upToDate: false });
  await updateAvailable(n, { version: "2.14.0", upToDate: false });
  assert.deepEqual(
    n.sent.map((notice) => [notice.kind, notice.label]),
    [
      ["update-available", "2.13.0"],
      ["update-available", "2.14.0"],
    ],
  );
});

test("a failed release job notifies once; old failures and other jobs never", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-release-events-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const jobs = path.join(dataDir, "operations/jobs");
  await fs.mkdir(jobs, { recursive: true });
  let now = Date.parse("2026-10-30T12:00:00Z");
  const job = (id, fields) =>
    fs.writeFile(path.join(jobs, `${id}.json`), JSON.stringify({ id, ...fields }));
  const at = (ms) => new Date(now - ms).toISOString();
  await job("aaaa-1", {
    kind: "release-activate",
    status: "failed",
    finishedAt: at(60000),
  });
  await job("aaaa-2", { kind: "release-stage", status: "succeeded", finishedAt: at(1) });
  await job("aaaa-3", { kind: "backup", status: "failed", finishedAt: at(1) });
  await job("aaaa-4", {
    kind: "release-rollback",
    status: "failed",
    finishedAt: at(releaseFailureWindowMs + 1),
  });
  const n = fakeNotifications();
  const events = new ReleaseFailureEvents({
    dataDir,
    notifications: n,
    now: () => now,
    intervalMs: 30000,
  });
  await events.poll();
  assert.equal(n.sent.length, 1);
  assert.equal(n.sent[0].kind, "update-failed");
  // Checked at most every 30 seconds, and the same job never again.
  await job("aaaa-5", {
    kind: "release-stage",
    status: "interrupted",
    finishedAt: at(1),
  });
  await events.poll();
  assert.equal(n.sent.length, 1);
  now += 30000;
  await events.poll();
  now += 30000;
  await events.poll();
  assert.equal(n.sent.length, 2);
  // A restarted server remembers what it announced (the observations table).
  const restarted = new ReleaseFailureEvents({
    dataDir,
    notifications: n,
    now: () => now,
  });
  await restarted.poll();
  assert.equal(n.sent.length, 2);
});

function operations({ controlled = false } = {}) {
  const notifications = fakeNotifications();
  const session = {
    id: "session-one",
    name: "api-refactor",
    tool: "claude",
    cwd: "/home/owner/shop",
    status: "running",
  };
  const events = new OperationsEvents({
    audit: { append() {} },
    notifications,
    sessions: { list: async () => [session], get: async () => session },
    activity: { read: async () => ({ state: "idle" }) },
    pipelines: { store: { all: () => [] } },
    intervalMs: 0,
    assistants: controlled
      ? { workflows: { sessions: { controls: () => true } } }
      : undefined,
  });
  return { events, notifications };
}
const settle = () => new Promise(setImmediate);

test("a usage limit notifies once per occurrence, with the CLI's reset message", async (t) => {
  const { events, notifications } = operations();
  t.after(() => events.close());
  const detail = "You've hit your limit · resets 4pm";
  events.nativeActivity("session-one", "StopFailure", { failure: "usage-limit", detail });
  await settle();
  events.nativeActivity("session-one", "StopFailure", { failure: "usage-limit", detail });
  await settle();
  assert.equal(notifications.sent.length, 1);
  assert.deepEqual(notifications.sent[0], {
    kind: "session-limited",
    eventId: notifications.sent[0].eventId,
    sessionId: "session-one",
    label: "api-refactor",
    tool: "claude",
    project: "shop",
    preview: detail,
  });
  // A turn that finishes normally ends it; the next limit notifies again.
  events.nativeActivity("session-one", "Stop");
  events.nativeActivity("session-one", "turn/completed", { failure: "usage-limit" });
  await settle();
  assert.equal(notifications.sent.length, 2);
  assert.notEqual(notifications.sent[0].eventId, notifications.sent[1].eventId);
  // Other failures are no limit.
  events.nativeActivity("session-one", "StopFailure", { failure: "server" });
  await settle();
  assert.equal(notifications.sent.length, 2);
});

test("an agent's session wakes its agent instead of notifying a limit", async (t) => {
  const { events, notifications } = operations({ controlled: true });
  t.after(() => events.close());
  events.nativeActivity("session-one", "StopFailure", { failure: "usage-limit" });
  await settle();
  assert.equal(notifications.sent.length, 0);
});

test("a failed auto-resume notifies once per interruption", async (t) => {
  const { events, notifications } = operations();
  t.after(() => events.close());
  const interruption = { at: "2026-10-30T10:00:00.000Z", resume: "failed" };
  await events.resumeFailed({ id: "session-one", name: "api" }, interruption);
  assert.equal(notifications.sent[0].kind, "session-resume-failed");
  assert.equal(notifications.sent[0].sessionId, "session-one");
  await events.resumeFailed({ id: "session-one", name: "api" }, interruption);
  // The same interruption keeps its event id, so the service delivers it once.
  assert.equal(notifications.sent[0].eventId, notifications.sent[1].eventId);
});

test("Claude's StopFailure and Codex's failed turn report the usage limit", () => {
  assert.deepEqual(
    hookPush({
      hook_event_name: "StopFailure",
      error: "rate_limit",
      last_assistant_message: "You've hit your limit · resets 4pm",
    }),
    {
      type: "activity",
      event: "StopFailure",
      failure: "usage-limit",
      detail: "You've hit your limit · resets 4pm",
    },
  );
  assert.equal(
    hookPush({ hook_event_name: "StopFailure", error: "server_error" }).failure,
    undefined,
  );
  const reports = [];
  const observe = codexActivityTracker(
    (update) => reports.push(update),
    () => 1,
  );
  observe({ method: "turn/started", params: { threadId: "t" } });
  observe({
    method: "turn/completed",
    params: {
      threadId: "t",
      turn: {
        status: "failed",
        error: {
          message: "Usage limit reached. Try again at 8 PM.",
          codexErrorInfo: "usageLimitExceeded",
        },
      },
    },
  });
  // Reported even though the state stays idle.
  observe({
    method: "turn/completed",
    params: {
      threadId: "t",
      turn: { error: { codex_error_info: "usage_limit_exceeded" } },
    },
  });
  assert.deepEqual(
    reports.map(({ failure, detail }) => [failure, detail]),
    [
      [undefined, undefined],
      ["usage-limit", "Usage limit reached. Try again at 8 PM."],
      ["usage-limit", undefined],
    ],
  );
  // The broker keeps the failure only on a turn's end, and only this one.
  assert.deepEqual(
    nativePushValue({
      type: "activity",
      event: "turn/completed",
      failure: "usage-limit",
      detail: "x",
    }),
    { type: "activity", event: "turn/completed", failure: "usage-limit", detail: "x" },
  );
  assert.deepEqual(
    nativePushValue({ type: "activity", event: "Stop", failure: "usage-limit" }),
    { type: "activity", event: "Stop" },
  );
  assert.deepEqual(
    nativePushValue({ type: "activity", event: "StopFailure", failure: "other" }),
    { type: "activity", event: "StopFailure" },
  );
});
