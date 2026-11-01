import test from "node:test";
import assert from "node:assert/strict";
import {
  agentPierRoutine,
  chatTarget,
  hookEventOf,
  hookMarker,
  offeredSchedule,
  reminderMarker,
  routineSchedule,
  sameRun,
} from "../../server/features/assistants/routine-definition.js";
import { serverSources } from "../helpers/runtime-port-scan.js";

test("markers keep the strings stored with existing runtime jobs", () => {
  assert.equal(reminderMarker("b1"), "agentpier-reminder:b1");
  assert.equal(hookMarker("e1"), "agentpier-hook:e1");
  assert.equal(hookEventOf({ marker: hookMarker("e1") }), "e1");
  assert.equal(hookEventOf({ marker: "agentpier-hook:" }), "");
  assert.equal(hookEventOf({ marker: reminderMarker("b1") }), null);
  assert.equal(hookEventOf({ marker: null }), null);
  assert.equal(agentPierRoutine({ marker: reminderMarker("b1") }), true);
  assert.equal(agentPierRoutine({ marker: hookMarker("e1") }), true);
  assert.equal(agentPierRoutine({ marker: null }), false);
  assert.equal(agentPierRoutine({ marker: "mine" }), false);
});

test("AgentPier's stored schedules become routine schedules and back", () => {
  const cron = { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" };
  const at = { kind: "at", at: "2099-01-01T08:00:00.000Z" };
  assert.deepEqual(routineSchedule(cron), {
    kind: "cron",
    expression: "0 9 * * *",
    timezone: "Europe/Berlin",
  });
  assert.deepEqual(offeredSchedule(routineSchedule(cron)), cron);
  assert.deepEqual(offeredSchedule(routineSchedule(at)), at);
  assert.deepEqual(routineSchedule({ kind: "cron", expr: "* * * * *" }), {
    kind: "cron",
    expression: "* * * * *",
  });
  assert.equal(offeredSchedule({ kind: "every", everyMs: 1 }), null);
  assert.equal(offeredSchedule(null), null);
});

test("sameRun compares the target, the prompt fields asked for and the delivery", () => {
  const want = {
    target: chatTarget("agent:a:main"),
    prompt: { text: "Go", timeoutSeconds: 300, fullContext: true, tools: ["read"] },
    delivery: { kind: "chat", url: "http://x/complete/b" },
  };
  // A model override or other prompt fields the runtime keeps do not count.
  const routine = { ...want, prompt: { ...want.prompt, model: "m" } };
  assert.equal(sameRun(routine, want), true);
  for (const changed of [
    { target: chatTarget("agent:a:other") },
    { target: { kind: "own" } },
    { prompt: { ...want.prompt, tools: [] } },
    { prompt: { ...want.prompt, fullContext: false } },
    { prompt: null },
    { delivery: { kind: "chat", url: "http://y" } },
    { delivery: { kind: "webhook", url: want.delivery.url } },
    { delivery: null },
  ])
    assert.equal(
      sameRun({ ...routine, ...changed }, want),
      false,
      JSON.stringify(changed),
    );
  const own = { target: { kind: "own" }, prompt: { text: "x" }, delivery: want.delivery };
  assert.equal(sameRun({ ...own, target: { kind: "own" } }, own), true);
});

// AGENTPIER-319: which routine run a session belongs to is the runtime's to tell
// (routines.runOf, routineRunOf). Allowlisted: memory note ids AgentPier stored with
// a run's session in them; this list may only shrink.
const sessionParsers = /:cron:|agent:<id>:cron/;
const allowlist = ["server/features/assistants/routine-run-notes.js"];

test("no server file outside the runtime port parses routine run sessions", async () => {
  const found = (await serverSources())
    .filter(({ text }) =>
      text
        .split("\n")
        .some((line) => !/^\s*(\/\/|\*)/.test(line) && sessionParsers.test(line)),
    )
    .map(({ file }) => file);
  assert.deepEqual(found, allowlist);
});
