import test from "node:test";
import assert from "node:assert/strict";
import { execContinuationFixture as setup } from "../helpers/exec-continuation-fixture.js";
import {
  continuationWindowMs,
  execEvidence as validEvidence,
  processRefusal,
} from "../../server/features/assistants/exec-continuation.js";
import { completedProcesses } from "../../server/features/assistants/team-plugin/exec-processes.js";

// Which processes a completion run may be credited for (exec-continuation.js,
// team-plugin/exec-processes.js): only those the owner turn's own run started in
// the background, and only while no process of another run could be meant.

test("a completion credits only processes the owner turn started in the background", async (t) => {
  // A forwarded turn starts a background command; the owner's later turn runs a
  // foreground exec; the forwarded turn's command completes.
  const f = await setup(t);
  await f.turn({ kind: "owner", forwarded: true }, { sessionId: "brisk-orbit" });
  await f.turn({ kind: "owner" }, { sessionId: "calm-wharf", status: "completed" });
  assert.equal(await f.call("MEMORY.md", { ctx: await f.wake() }), false);
  // The owner turn's own background command, while another turn's completes.
  const g = await setup(t);
  await g.turn({ kind: "owner", forwarded: true }, { sessionId: "brisk-orbit" });
  await g.turn({ kind: "owner" }, { sessionId: "calm-wharf" });
  assert.equal(await g.call("notes.md", { ctx: await g.wake() }), false);
  // Both in one completion: the other turn's process still refuses.
  const h = await setup(t);
  await h.turn({ kind: "owner", forwarded: true }, { sessionId: "brisk-orbit" });
  await h.turn({ kind: "owner" }, { sessionId: "calm-wharf" });
  const both = [
    "Exec completed (calm-wha, code 0) :: built",
    "Exec failed (brisk-or, code 1) :: done",
  ];
  assert.equal(
    await h.call("notes.md", { ctx: await h.wake("w", { lines: both }) }),
    false,
  );
  // Its own process alone continues it, also with another turn's command around.
  const i = await setup(t);
  await i.turn({ kind: "owner", forwarded: true }, { sessionId: "brisk-orbit" });
  const attemptId = await i.turn({ kind: "owner" }, { sessionId: "calm-wharf" });
  const own = ["Exec completed (calm-wha, code 0) :: built"];
  assert.equal(
    await i.call("notes.md", { ctx: await i.wake("w", { lines: own }) }),
    true,
  );
  assert.deepEqual(i.writes(), [["notes.md", attemptId]]);
  assert.deepEqual([...f.writes(), ...g.writes(), ...h.writes()], []);
});

test("a prefix another run's process shares refuses, however old that process is", async (t) => {
  const own = ["Exec completed (oceanic-, code 0) :: built"];
  // OpenClaw's slugs share prefixes (every oceanic-* id reports "oceanic-") and get
  // numbered suffixes; the other process started long before, with hundreds of
  // other commands since, where no transcript tail would reach it.
  for (const foreign of ["oceanic-cove", "oceanic-reef-2"]) {
    const f = await setup(t);
    await f.turn({ kind: "owner", forwarded: true }, { sessionId: foreign });
    const filler = await f.turn({ kind: "owner" }, { exec: false });
    for (let n = 0; n < 300; n += 1) await f.exec(filler, { sessionId: `quiet-${n}` });
    await f.turn({ kind: "owner" }, { sessionId: "oceanic-reef" });
    assert.equal(
      await f.call("notes.md", { ctx: await f.wake("w", { lines: own }) }),
      false,
      foreign,
    );
  }
  // Two of the owner turn's own processes with one prefix are both its own.
  const g = await setup(t);
  const attempt = await g.turn({ kind: "owner" }, { sessionId: "oceanic-reef" });
  await g.exec(attempt, { sessionId: "oceanic-reef-2" });
  assert.equal(
    await g.call("notes.md", { ctx: await g.wake("w", { lines: own }) }),
    true,
  );
});

test("a reported id must be the exact form OpenClaw emits", async (t) => {
  // A shorter id stands only for a process whose whole id it is.
  const f = await setup(t);
  await f.turn({ kind: "owner" }, { sessionId: "calm-shore" });
  const short = ["Exec completed (calm, code 0) :: x"];
  assert.equal(
    await f.call("notes.md", { ctx: await f.wake("w", { lines: short }) }),
    false,
  );
  const g = await setup(t);
  await g.turn({ kind: "owner" }, { sessionId: "calm" });
  assert.equal(
    await g.call("notes.md", { ctx: await g.wake("w", { lines: short }) }),
    true,
  );
  // The parser reads only OpenClaw's own process lines.
  const prompt = (lines) =>
    "An async command you ran earlier has completed. The command completion details " +
    `are:\n\n${lines.join("\n")}\n\nTreat this completion as an internal continuation.`;
  for (const lines of [
    [],
    ["Exec completed (brisk-or, code 1) :: done", "", "[truncated]"],
    ["Exec completed (brisk-or, code 1) :: done", "Some other event"],
    [
      "Exec finished (gateway id=abc, session=brisk-orbit, code 0)",
      "Exec completed (brisk-or, code 0)",
    ],
    ["Exec completed (brisk-orbit, code 0) :: done"],
  ])
    assert.equal(completedProcesses(prompt(lines)), null, lines.join("|"));
  assert.deepEqual(
    completedProcesses(
      prompt(["Exec failed (brisk-or, code 1) without captured stdout/stderr."]),
    ),
    ["brisk-or"],
  );
});

test("an incomplete or uncertain Gateway record proves nothing", async (t) => {
  // The record began after the Gateway started: earlier processes may be missing.
  const f = await setup(t, { started: false });
  await f.turn({ kind: "owner" });
  assert.equal(await f.call("notes.md", { ctx: await f.wake() }), false);
  // An exec result that may still start a command (an approval) or has an unknown
  // shape leaves the session uncertain.
  for (const result of [
    { details: { status: "approval-pending", approvalId: "a1" } },
    { details: {} },
    {},
  ]) {
    const g = await setup(t);
    const attempt = await g.turn({ kind: "owner" });
    await g.exec(attempt, { result });
    assert.equal(await g.call("notes.md", { ctx: await g.wake() }), false);
  }
  // Foreground results and errors leave nothing running. OpenClaw 2026.10.3 passes an
  // errored call as `createErrorToolResult`: its text and `details: {}`.
  const h = await setup(t);
  const attempt = await h.turn({ kind: "owner" });
  for (const error of [
    "Provide a command to start.",
    "exec host not allowed (requested node; configured host is gateway)",
    "Operation aborted",
    "Tool execution was aborted",
  ])
    await h.exec(attempt, {
      error,
      result: { content: [{ type: "text", text: error }], details: {} },
    });
  for (const status of ["completed", "failed", "denied"])
    await h.exec(attempt, { status, sessionId: "other-one" });
  assert.equal(await h.call("notes.md", { ctx: await h.wake() }), true);
  // An exec call whose result never came: refused while pending and after its run.
  const i = await setup(t);
  await i.turn({ kind: "owner" });
  const ctx = {
    agentId: i.agentId,
    sessionKey: "session",
    runId: "r9",
    toolCallId: "p1",
  };
  await i.emit("before_tool_call", { toolName: "exec", params: {} }, ctx);
  const run = await i.wake();
  assert.equal(await i.call("notes.md", { ctx: run }), false);
  await i.emit("agent_end", {}, ctx);
  assert.equal(await i.call("notes.md", { ctx: { ...run } }), false);
});

test("the evidence is validated and judged by the attempt's run", () => {
  const attempt = { id: "a1", createdAt: new Date(1000).toISOString() };
  const evidence = (over = {}) => ({
    complete: true,
    processes: [{ id: "brisk-orbit", runId: "a1" }],
    completion: { runId: "w1", ids: ["brisk-or"], at: 2000 },
    ...over,
  });
  assert.equal(processRefusal(validEvidence(evidence()), attempt, "w1"), null);
  for (const [value, code] of [
    [null, "EVIDENCE"],
    [evidence({ complete: false }), "UNTRACKED"],
    [evidence({ completion: null }), "NOT_COMPLETION"],
    [evidence({ completion: { runId: "w1", ids: null, at: 2000 } }), "PROCESSES"],
    [evidence({ processes: [] }), "PROCESS"],
    [evidence({ processes: [{ id: "brisk-orbit", runId: "x" }] }), "PROCESS"],
    [
      evidence({
        completion: {
          runId: "w1",
          ids: ["brisk-or"],
          at: 1000 + continuationWindowMs + 1,
        },
      }),
      "WINDOW",
    ],
  ])
    assert.equal(processRefusal(validEvidence(value), attempt, "w1"), code);
  assert.equal(
    processRefusal(validEvidence(evidence()), attempt, "w2"),
    "NOT_COMPLETION",
  );
  // Malformed evidence is no evidence.
  for (const bad of [
    { ...evidence(), processes: [{ id: 1, runId: "a1" }] },
    { ...evidence(), processes: Array(257).fill({ id: "x", runId: "a1" }) },
    { ...evidence(), completion: { runId: "w1", ids: ["toolongid"], at: 2000 } },
    { ...evidence(), complete: "yes" },
  ])
    assert.equal(validEvidence(bad), null);
});

test("refusals are logged once per run and reason, by code only", async (t) => {
  const f = await setup(t);
  const warnings = [];
  f.bridge.warn = (message) => warnings.push(message);
  await f.turn({ kind: "owner", forwarded: true }, { sessionId: "brisk-orbit" });
  await f.turn({ kind: "owner" }, { exec: false });
  const ctx = await f.wake("wake-logged");
  assert.equal(await f.call("secret-plan.md", { ctx }), false);
  assert.equal(await f.call("secret-plan.md", { ctx }), false);
  // A call without a run, or of a run the Gateway never reported as heartbeat-driven,
  // is no continuation: refused without a log line.
  const { runId: _runId, ...unnamed } = ctx;
  assert.equal(await f.call("secret-plan.md", { ctx: unnamed }), false);
  assert.equal(
    await f.call("secret-plan.md", { ctx: { ...ctx, runId: "chat-run" } }),
    false,
  );
  t.diagnostic(JSON.stringify(warnings));
  assert.deepEqual(
    warnings.map((w) => w.match(/\((\w+)\)\.$/)?.[1]),
    ["PROCESS"],
  );
  assert.ok(warnings.every((w) => !w.includes("secret-plan")));
});
