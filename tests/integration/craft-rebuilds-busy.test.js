import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statusView } from "../../server/features/craft/craft-mcp-tools.js";
import { rebuildsFixture, until } from "../helpers/craft-rebuilds-fixture.js";

/** Collects console.error lines for the test's duration. */
function capturedErrors(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  t.after(() => (console.error = original));
  return lines;
}

/** The `kind` lines of the fake's call log after its first `from` lines. */
const callLines = (file, kind, from = 0) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .slice(from)
    .filter((line) => line.startsWith(`${kind} `));

// The live owner log showed one CRAFT_MCP_TIMEOUT per sample tick (about 20 in a row)
// while Craft Anything was busy: every tick queued a new read behind the abandoned
// ones and the rebuild kept reading as a live "building" with nothing to say otherwise.
test("a busy Craft Anything is read once at a time, logged once and shown as not answering", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "craft-busy-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const busyFile = path.join(scratch, "busy");
  const callLog = path.join(scratch, "calls.log");
  const f = rebuildsFixture(t, {
    script: { busyFile, callLog },
    sampleMs: 50,
    readTimeoutMs: 150,
  });
  const view = await f.rebuilds.start({ request: "Busy" });
  assert.ok(await until(() => f.rebuilds.get(view.id).status === "building"));
  assert.equal(f.rebuilds.get(view.id).notAnsweringSince, null);
  const events = [];
  f.rebuilds.onChange((event) => events.push(event));
  const errors = capturedErrors(t);

  const before = fs.readFileSync(callLog, "utf8").split("\n").length - 1;
  fs.writeFileSync(busyFile, "");
  assert.ok(
    await until(() => f.rebuilds.get(view.id).notAnsweringSince !== null),
    "the rebuild reads as not answering",
  );
  assert.ok(
    events.some((event) => event.id === view.id),
    "the change is pushed",
  );
  // Several sample ticks pass while Craft Anything stays busy.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const stalled = f.rebuilds.get(view.id);
  assert.equal(stalled.status, "building", "the last known state stays");
  assert.equal(statusView(stalled).notAnsweringSince, stalled.notAnsweringSince);
  const timeouts = errors.filter((line) => line.includes("CRAFT_MCP_TIMEOUT"));
  assert.ok(timeouts.length <= 2, `logged once per stall, not per tick: ${timeouts}`);
  // Every read that timed out was cancelled, so none waits in Craft Anything.
  const calls = callLines(callLog, "call", before).length;
  const cancels = callLines(callLog, "cancel", before).length;
  assert.ok(calls >= 3 && cancels >= calls - 1, `${cancels} of ${calls} reads cancelled`);
  // The page's activity read does not queue behind a busy child either.
  const asked = Date.now();
  await assert.rejects(f.rebuilds.activity(view.id), { status: 409 });
  assert.ok(Date.now() - asked < 100, "refused at once");

  fs.rmSync(busyFile);
  assert.ok(
    await until(() => f.rebuilds.get(view.id).notAnsweringSince === null),
    "the next answer ends the stall",
  );
  assert.equal(f.rebuilds.get(view.id).status, "building");
  assert.ok((await f.rebuilds.activity(view.id)).lines.length > 0);
});

test("a paused rebuild no longer reads as not answering", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "craft-busy-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const busyFile = path.join(scratch, "busy");
  const f = rebuildsFixture(t, {
    script: { busyFile },
    sampleMs: 50,
    readTimeoutMs: 150,
  });
  const view = await f.rebuilds.start({ request: "Busy then lost" });
  capturedErrors(t);
  fs.writeFileSync(busyFile, "");
  assert.ok(await until(() => f.rebuilds.get(view.id).notAnsweringSince !== null));
  process.kill(f.clients[0].pid, "SIGKILL");
  assert.ok(await until(() => f.rebuilds.get(view.id).status === "paused"));
  assert.equal(f.rebuilds.get(view.id).notAnsweringSince, null);
});
