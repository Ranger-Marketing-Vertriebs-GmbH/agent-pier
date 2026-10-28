import test from "node:test";
import assert from "node:assert/strict";
import { gateway } from "../helpers/exec-gateway.js";

// AGENTPIER-274: OpenClaw's refusals before it spawns start nothing, an exec call of
// unknown outcome refuses other runs' completions only while its run lasts, and a
// command a completion run starts belongs to the run that completion continues.

test("OpenClaw 2026.10.7's supervisor refusals before spawning count as not started", (t) => {
  const g = gateway(t);
  // supervisor startRun: thrown before the child process is spawned.
  for (const text of [
    "Execution command and arguments must not contain NUL bytes. Remove them and retry.",
    "spawn argv cannot be empty",
    "PTY is unavailable when execution requires process-tree cleanup",
  ]) {
    g.exec("s", "r0", { content: [{ type: "text", text }], details: {} }, text);
    // As 2026.10.7 reports an error thrown inside the exec tool.
    const json = JSON.stringify({ status: "error", tool: "exec", error: text }, null, 2);
    const details = { status: "error", tool: "exec", error: text };
    g.exec("s", "r0", { content: [{ type: "text", text: json }], details }, text);
  }
  g.background("s", "r1", "brisk-orbit");
  g.complete("s", "w1", ["brisk-or"]);
  assert.deepEqual(g.proof("s", "w1").processes, [{ id: "brisk-orbit", runId: "r1" }]);
  // Quoted in a longer message it is no such refusal.
  const quoted = "Error: spawn argv cannot be empty (retrying in the background)";
  g.exec("s", "r2", { content: [{ type: "text", text: quoted }], details: {} }, quoted);
  assert.deepEqual(g.proof("s", "w1").processes.at(-1), { id: "*", runId: "r2" });
});

test("an unknown process refuses only until its run ends, at most its bound", (t) => {
  const g = gateway(t, { bounds: { completingMs: 50 } });
  g.background("s", "r1", "brisk-orbit");
  g.exec(
    "s",
    "r2",
    { content: [{ type: "text", text: "Aborted" }], details: {} },
    "Aborted",
  );
  g.exec(
    "s",
    "r3",
    { content: [{ type: "text", text: "Aborted" }], details: {} },
    "Aborted",
  );
  g.complete("s", "w1", ["brisk-or"]);
  const runs = () => g.proof("s", "w1").processes.map((p) => p.runId);
  assert.deepEqual(runs(), ["r1", "r2", "r3"]);
  g.emit("agent_end", {}, { runId: "r2" });
  assert.deepEqual(runs(), ["r1", "r3"]);
  const until = Date.now() + 60;
  while (Date.now() < until);
  assert.deepEqual(runs(), ["r1"]);
});

test("a command a completion run starts is credited to the run it continues", (t) => {
  const g = gateway(t);
  g.background("s", "owner-run", "lucky-tidepool");
  g.complete("s", "w1", ["lucky-ti"]);
  // The completion run exports in the background; its completion's run checks it.
  g.background("s", "w1", "young-canyon");
  g.emit("agent_end", {}, { runId: "w1" });
  g.complete("s", "w2", ["young-ca"]);
  g.background("s", "w2", "fresh-meadow");
  g.complete("s", "w3", ["fresh-me"]);
  assert.deepEqual(g.proof("s", "w3").processes, [
    { id: "fresh-meadow", runId: "owner-run" },
  ]);
  // A completion reporting two runs' processes credits nothing.
  g.background("s", "other-run", "calm-shore");
  g.complete("s", "w4", ["fresh-me", "calm-sho"]);
  g.background("s", "w4", "kind-cloud");
  g.complete("s", "w5", ["kind-clo"]);
  assert.deepEqual(g.proof("s", "w5").processes, [{ id: "kind-cloud", runId: "w4" }]);
  // Nor does an ordinary run, or one in another session.
  g.background("s", "chat-run", "bold-river");
  g.background("o", "w3", "warm-delta");
  g.complete("s", "w6", ["bold-riv"]);
  g.complete("o", "w7", ["warm-del"]);
  assert.deepEqual(g.proof("s", "w6").processes, [
    { id: "bold-river", runId: "chat-run" },
  ]);
  assert.deepEqual(g.proof("o", "w7").processes, [{ id: "warm-delta", runId: "w3" }]);
});

test("an incomplete record names why", (t) => {
  const late = gateway(t, { started: false });
  late.background("s", "r1", "brisk-orbit");
  late.complete("s", "w1", ["brisk-or"]);
  assert.equal(late.proof("s", "w1").incomplete, "late-start");
  const g = gateway(t, { bounds: { maxProcesses: 1 } });
  g.emit(
    "before_tool_call",
    { toolName: "exec" },
    { sessionKey: "p", runId: "r", toolCallId: "x" },
  );
  assert.equal(g.proof("p", "w").incomplete, "pending");
  for (const id of ["a-1", "a-2"]) g.background("busy", "r1", id);
  assert.equal(g.proof("busy", "w").incomplete, "too-many");
  assert.equal("incomplete" in g.proof("quiet", "w"), false);
});
