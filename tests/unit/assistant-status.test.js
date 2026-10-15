import test from "node:test";
import assert from "node:assert/strict";
import { assistantCopy as copy } from "../../web/lib/i18n/de/assistants.js";
import {
  IDLE_ACTIVITY,
  activityDot,
  activityFor,
  copyAt,
  headerStatus,
  sidebarSubline,
} from "../../web/features/assistants/assistant-status.js";

const assistant = { id: "home", model: { connectionId: "router", modelId: "gpt-x" } };
const models = [{ id: "router" }];
const ready = { availability: "ready" };
const entry = (state, label, extra = {}) => ({
  state,
  reason: "attempt",
  label,
  pendingApprovals: 0,
  team: null,
  ...extra,
});
const status = (input) =>
  headerStatus({
    assistant,
    models,
    runtime: ready,
    attempt: null,
    entry: IDLE_ACTIVITY,
    member: null,
    copy,
    ...input,
  });

test("missing or partial activity falls back to idle", () => {
  assert.equal(activityFor(undefined, "home"), IDLE_ACTIVITY);
  assert.equal(activityFor({}, "home"), IDLE_ACTIVITY);
  assert.equal(IDLE_ACTIVITY.state, "idle");
  assert.ok(Object.isFrozen(IDLE_ACTIVITY));
  const working = entry("working", "status.running");
  assert.equal(activityFor({ home: working }, "home"), working);
});

test("activity dots reuse the session dot states", () => {
  assert.equal(activityDot(entry("working")), "working");
  assert.equal(activityDot(entry("waiting")), "waiting");
  assert.equal(activityDot(entry("attention")), "unknown");
  assert.equal(activityDot(IDLE_ACTIVITY), null);
});

test("copy paths resolve nested keys and tolerate unknown ones", () => {
  assert.equal(copyAt(copy, "status.running"), "Arbeitet");
  assert.equal(copyAt(copy, "team.states.queued"), "Wartet auf Kapazität");
  assert.equal(copyAt(copy, "teamActive.awaiting"), "Team wartet auf Freigabe");
  assert.equal(copyAt(copy, "status.nope"), undefined);
  assert.equal(copyAt(copy, null), undefined);
});

test("header status follows the documented precedence", () => {
  assert.deepEqual(status({ models: [] }), {
    tone: "missing",
    label: "Zugang fehlt",
  });
  assert.deepEqual(status({ runtime: { availability: "starting" } }), {
    tone: "muted",
    label: "Startet",
  });
  assert.deepEqual(status({ runtime: { availability: "failed" } }), {
    tone: "attention",
    label: "Fehlgeschlagen",
  });
  assert.deepEqual(status({ attempt: { state: "accepted" } }), {
    tone: "working",
    label: "Angenommen",
  });
  assert.deepEqual(status({ attempt: { state: "uncertain" } }), {
    tone: "attention",
    label: "Ausgang unklar",
  });
  assert.deepEqual(
    status({ entry: entry("waiting", "teamActive.awaiting", { team: "awaiting" }) }),
    { tone: "waiting", label: "Team wartet auf Freigabe" },
  );
  assert.deepEqual(status({ entry: entry("working", "teamActive.working") }), {
    tone: "working",
    label: "Team arbeitet",
  });
  assert.deepEqual(status({}), { tone: "ready", label: "Bereit" });
  assert.deepEqual(status({ member: { phase: "completed" } }), {
    tone: "ready",
    label: "Abgeschlossen",
  });
});

test("sidebar subline prefers team state, then activity, then the model", () => {
  const subline = (input) => sidebarSubline({ assistant, member: null, copy, ...input });
  assert.deepEqual(subline({ entry: IDLE_ACTIVITY, model: assistant.model }), {
    text: "gpt-x",
    tone: "meta",
  });
  assert.deepEqual(
    subline({
      entry: entry("working", "status.running", { team: "awaiting" }),
      model: assistant.model,
    }),
    { text: "Team wartet auf Freigabe", tone: "accent" },
  );
  assert.deepEqual(
    subline({ entry: entry("working", "status.running"), model: assistant.model }),
    { text: "Arbeitet", tone: "accent" },
  );
  assert.deepEqual(
    subline({
      entry: IDLE_ACTIVITY,
      model: assistant.model,
      member: { role: "Review", phase: "ready" },
    }),
    { text: "Bereit", tone: "meta" },
  );
  assert.deepEqual(
    subline({
      entry: entry("working", "team.states.running", { reason: "member" }),
      model: assistant.model,
      member: { role: "Review", phase: "running" },
    }),
    { text: "Arbeitet", tone: "accent" },
  );
});

// A turn that waits for a shell approval stays "accepted" until the owner decides;
// the header must say what it waits for, as the sidebar does, for every agent.
test("header status shows a pending approval before the running attempt", () => {
  const waiting = entry("waiting", "team.states.awaiting_approval", {
    reason: "approval",
    pendingApprovals: 1,
  });
  for (const state of ["pending", "accepted", "running"])
    assert.deepEqual(status({ attempt: { state }, entry: waiting }), {
      tone: "waiting",
      label: "Wartet auf Freigabe",
    });
  assert.deepEqual(
    status({ attempt: { state: "accepted" }, entry: entry("working", "status.running") }),
    { tone: "working", label: "Angenommen" },
  );
  // An unclear outcome still needs the owner's review first.
  assert.deepEqual(status({ attempt: { state: "uncertain" }, entry: waiting }), {
    tone: "attention",
    label: "Ausgang unklar",
  });
});
