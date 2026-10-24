import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  activityGroupView,
  groupActivity,
} from "../../web/features/assistants/activity-groups.js";
import { activityGroupHead, toolSummary } from "../../web/components/activity-group.js";

const ssh = (id, extra = {}) => ({
  message: {
    id: `ssh-run:${id}`,
    role: "event",
    event: "ssh-run",
    hostName: "proxmox-2",
    commandPreview: "uptime",
    outcome: "done",
    ...extra,
  },
});
const text = (id, role = "assistant") => ({ message: { id, role, text: id } });
const shape = (items) =>
  items.map((item) =>
    item.activity ? item.activity.map((m) => m.id) : (item.message?.id ?? item.note.id),
  );

test("consecutive tool calls between two texts fold into one group", () => {
  const items = [text("u1", "user"), ssh("a"), ssh("b"), ssh("c"), text("r1")];
  const grouped = groupActivity(items);
  assert.deepEqual(shape(grouped), ["u1", ["ssh-run:a", "ssh-run:b", "ssh-run:c"], "r1"]);
  assert.equal(grouped[1].key, "activity:ssh-run:a");
});

test("text between calls ends a group, and a single call stays a row", () => {
  const items = [ssh("a"), ssh("b"), text("r1"), ssh("c"), text("u2", "user"), ssh("d")];
  const grouped = groupActivity(items);
  assert.deepEqual(shape(grouped), [
    ["ssh-run:a", "ssh-run:b"],
    "r1",
    "ssh-run:c",
    "u2",
    "ssh-run:d",
  ]);
  assert.equal(grouped[2], items[3]);
});

test("a team note or another event ends a group", () => {
  const items = [
    ssh("a"),
    { note: { id: "team:1" } },
    ssh("b"),
    { message: { id: "m1", role: "event", event: "memory-note" } },
    ssh("c"),
  ];
  assert.deepEqual(shape(groupActivity(items)), [
    "ssh-run:a",
    "team:1",
    "ssh-run:b",
    "m1",
    "ssh-run:c",
  ]);
});

test("a group of calls on one host names it and reads done", () => {
  setLanguage("en");
  const messages = groupActivity([
    ssh("a"),
    ssh("b"),
    ssh("c", { outcome: "truncated" }),
  ])[0].activity;
  const view = activityGroupView(messages);
  assert.deepEqual(view, {
    label: "SSH activity",
    count: 3,
    summary: "proxmox-2",
    failed: 0,
    stopped: 0,
    running: false,
    done: true,
  });
  assert.deepEqual(activityGroupHead(view), {
    detail: "3 calls · proxmox-2",
    status: "Done",
    tone: "ok",
  });
});

test("mixed hosts are counted and failures stay visible", () => {
  setLanguage("en");
  const view = activityGroupView([
    ssh("a").message,
    ssh("b", { hostName: "nas-01", outcome: "exit", exitCode: 1 }).message,
    ssh("c", { hostName: "opnsense", outcome: "timedOut" }).message,
    ssh("d", { outcome: "revoked" }).message,
  ]);
  assert.deepEqual(activityGroupHead(view), {
    detail: "4 calls · 3 hosts",
    status: "3 failed",
    tone: "error",
  });
});

test("a running call marks the group running, next to its failures", () => {
  setLanguage("en");
  const running = ssh("b", { outcome: "running" }).message;
  const alone = activityGroupHead(activityGroupView([ssh("a").message, running]));
  assert.deepEqual([alone.status, alone.tone], ["Running", "running"]);
  const view = activityGroupHead(
    activityGroupView([ssh("a", { outcome: "exit", exitCode: 2 }).message, running]),
  );
  assert.deepEqual([view.status, view.tone], ["Running · 1 failed", "error"]);
});

test("the German group reads like the session chat's agent activity", () => {
  setLanguage("de");
  const view = activityGroupView([
    ssh("a").message,
    ssh("b", { outcome: "exit", exitCode: 1 }).message,
  ]);
  const head = activityGroupHead(view);
  assert.deepEqual(
    [view.label, head.detail, head.status],
    ["SSH-Aktivität", "2 Aufrufe · proxmox-2", "1 fehlgeschlagen"],
  );
  setLanguage("en");
});

test("session chat groups name their main tools and show no chip while unknown", () => {
  setLanguage("en");
  const names = ["Read", "Bash", "Edit", "Bash", "Read", "Bash", "Grep", "Read", "Edit"];
  assert.equal(toolSummary(names), "Read 3 · Bash 3 · Edit 2");
  assert.equal(toolSummary(["Bash"]), "Bash 1");
  assert.deepEqual(activityGroupHead({ count: 1, summary: "Bash 1" }), {
    detail: "1 call · Bash 1",
    status: null,
    tone: "ok",
  });
  assert.equal(activityGroupHead({ count: 2, done: true }).detail, "2 calls");
});

const sftp = (id, extra = {}) => ({
  message: {
    id: `sftp-run:${id}`,
    role: "event",
    event: "sftp-run",
    hostName: "proxmox-2",
    operation: "upload",
    direction: "up",
    remotePath: "/srv/www",
    state: "completed",
    ...extra,
  },
});

test("SFTP rows join the SSH rows' group instead of ending it", () => {
  const items = [text("u1", "user"), ssh("a"), sftp("b"), ssh("c"), text("r1")];
  assert.deepEqual(shape(groupActivity(items)), [
    "u1",
    ["ssh-run:a", "sftp-run:b", "ssh-run:c"],
    "r1",
  ]);
});

test("SFTP states count as running, done, stopped or failed in their group", () => {
  setLanguage("en");
  const running = activityGroupView([
    sftp("a").message,
    sftp("b", { state: "executing" }).message,
  ]);
  assert.deepEqual(running, {
    label: "SFTP activity",
    count: 2,
    summary: "proxmox-2",
    failed: 0,
    stopped: 0,
    running: true,
    done: false,
  });
  const failed = activityGroupView([
    sftp("a", { state: "failed" }).message,
    sftp("b", { state: "cancelled" }).message,
    sftp("c", { state: "unknown" }).message,
    ssh("d").message,
  ]);
  assert.deepEqual(
    [failed.label, failed.failed, failed.stopped, failed.done],
    ["SSH activity", 2, 1, false],
  );
});

test("a stopped SFTP job counts as stopped, not failed, like its row", () => {
  setLanguage("en");
  const view = activityGroupView([
    sftp("a").message,
    sftp("b", { state: "cancelled" }).message,
  ]);
  assert.deepEqual([view.failed, view.stopped, view.done], [0, 1, false]);
  assert.deepEqual(activityGroupHead(view), {
    detail: "2 calls · proxmox-2",
    status: "1 stopped",
    tone: "neutral",
  });
  const mixed = activityGroupHead(
    activityGroupView([
      sftp("a", { state: "failed" }).message,
      sftp("b", { state: "cancelled" }).message,
    ]),
  );
  assert.deepEqual([mixed.status, mixed.tone], ["1 failed · 1 stopped", "error"]);
  setLanguage("de");
  assert.equal(activityGroupHead(view).status, "1 gestoppt");
  setLanguage("en");
});
