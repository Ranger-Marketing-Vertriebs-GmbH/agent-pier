import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDevicesFixture } from "../helpers/agent-devices-fixture.js";
import {
  deviceOrigin,
  deviceOriginKinds,
  taskOrigin,
} from "../../server/features/assistants/agent-device-origin.js";
import { internalKinds } from "../../server/features/assistants/conversations.js";
import { foreignKinds } from "../../server/features/assistants/owner-runs.js";

// Which recorded turn origins get an Android device (agent-device-origin.js
// deviceOrigin), decided by the owner per kind (AGENTPIER-508). The set is an
// allow-list, and this test pins it against the kinds the server records: a new
// origin kind fails here until someone decides whether its turns may use a device.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// "manage": use, and create, reset, delete; "use": use only; "none": no device.
const decided = {
  // The owner's own message, in the web chat or their paired Telegram chat.
  owner: "manage",
  telegram: "manage",
  // Content from the owner's own agents and sessions.
  reminder: "use",
  "member-result": "use",
  "team-result": "use",
  "coding-result": "use",
  "session-talk": "use",
  "coding-session": "use",
  "member-long-chat": "use",
  // Outcomes of the owner's approvals and AgentPier's own steps: refused unless a
  // concrete need shows.
  "mail-result": "none",
  "ssh-access-result": "none",
  "memory-result": "none",
  "memory-step": "none",
  "coding-start": "none",
  // Someone else's content (owner-runs.js foreignKinds).
  "ssh-result": "none",
  "sftp-result": "none",
  user: "none",
  "team-member": "none",
  "member-report": "none",
  "member-routine": "none",
  "member-hook": "none",
  "peer-result": "none",
  // A member's task is judged by its task (memberTask), never as a plain turn.
  "lead-request": "none",
  unknown: "none",
};
// Recorded as `owner` or `telegram` with a `goal` marker (goal-turns.js).
const goal = { id: "g1", anchorRequestId: "r1", title: "Ship" };
// What the scan below finds that is no turn's recorded origin: the stand-in for a
// run without a turn (owner-runs.js ownerChatCall) and a task's origin when a
// routine's run delegated it (lead-request-store.js; member-device-passes.js).
const notTurnOrigins = new Set(["agent-run", "routine"]);

// Every `{ kind: "<kind>" ...}` the server hands over as a turn's trusted context:
// the value of a `context`, `trustedContext` or `turnContext`, and the arguments of
// a `send`.
function recordedKinds() {
  const files = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith(".js")) files.push(file);
    }
  };
  for (const feature of ["assistants", "assistant-channels", "users"])
    walk(path.join(root, "server/features", feature));
  const literal = /\{\s*kind:\s*"([a-z][a-z-]*)"/g;
  const found = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const [, value] of source.matchAll(
      /\b(?:context|trustedContext|turnContext)\b\s*(?:[:=]|\?\?)\s*([^;]{0,400}?)(?:;|\n\s*\}\s*;)/g,
    ))
      for (const [, kind] of value.matchAll(literal)) found.add(kind);
    for (const [, args] of source.matchAll(
      /\b(?:send|sendTurn)\(([\s\S]{0,1500}?)\);[ \t]*\n/g,
    ))
      for (const [, kind] of args.matchAll(literal)) found.add(kind);
  }
  return found;
}

test("every origin kind the server records has a decision", () => {
  const scanned = recordedKinds();
  // The scan finds the places it is written for.
  for (const kind of ["owner", "telegram", "user", "memory-step", "team-result"])
    assert.ok(scanned.has(kind), `the scan no longer finds ${kind}`);
  const known = new Set([...scanned, ...internalKinds, ...foreignKinds]);
  // The history's name for a goal turn, not a recorded kind (goal-turns.js turnKind).
  known.delete("goal-continuation");
  const undecided = [...known]
    .filter((kind) => !Object.hasOwn(decided, kind) && !notTurnOrigins.has(kind))
    .sort();
  assert.deepEqual(
    undecided,
    [],
    "a new turn origin needs the owner's decision on Android devices: add it to `decided` here and, if it may use a device, to agent-device-origin.js",
  );
});

test("the gate's list is the decided one, and nothing else gets a device", () => {
  const using = Object.keys(decided).filter((kind) => decided[kind] !== "none");
  assert.deepEqual([...deviceOriginKinds].sort(), using.sort());
  for (const [kind, decision] of Object.entries(decided)) {
    assert.equal(deviceOrigin({ kind }), decision !== "none", kind);
    // Forwarded content never, whatever its kind.
    assert.equal(deviceOrigin({ kind, forwarded: true }), false, `${kind} forwarded`);
  }
  for (const origin of [
    null,
    undefined,
    "owner",
    {},
    { kind: null },
    { kind: "anything-new-and-unlisted" },
    { kind: "agent-run" },
    { kind: "routine" },
    { kind: "hook" },
    { kind: "goal-continuation" },
  ])
    assert.equal(deviceOrigin(origin), false, JSON.stringify(origin));
  // A goal turn that hands a result over is judged by that result as well.
  assert.equal(deviceOrigin({ kind: "owner", goal }), true);
  assert.equal(
    deviceOrigin({ kind: "owner", goal, result: { kind: "member-result" } }),
    true,
  );
  assert.equal(
    deviceOrigin({ kind: "owner", goal, result: { kind: "peer-result" } }),
    false,
  );
  // A task counts when the run that started it could use devices: a routine's run
  // records its own origin on the task.
  assert.equal(taskOrigin({ kind: "routine", bindingId: "b1" }), true);
  assert.equal(taskOrigin({ kind: "owner" }), true);
  for (const kind of ["mail-result", "hook", "agent-run", "unknown"])
    assert.equal(taskOrigin({ kind }), false, kind);
});

test("a turn uses and manages devices as its origin was decided", async (t) => {
  const f = await agentDevicesFixture(t);
  const pixel = await f.device("Pixel");
  f.assign(f.lead(), pixel, { manage: true, create: true });
  const got = async (context) => {
    const use = await f.code(f.call({ action: "list" }, context));
    if (use) return use === "DEVICE_RUN_FORBIDDEN" ? "none" : use;
    const manage = await f.code(f.call({ action: "reset", device: "Pixel" }, context));
    return manage === "DEVICE_OWNER_TURN_REQUIRED" ? "use" : (manage ?? "manage");
  };
  for (const [kind, decision] of Object.entries(decided)) {
    // A memory step reaches no bridge tool at all (team-bridge.js valid).
    const expected = kind === "memory-step" ? "FORBIDDEN" : decision;
    assert.equal(await got({ kind }), expected, kind);
  }
  assert.equal(await got({ kind: "anything-new-and-unlisted" }), "none");
  assert.equal(await got({}), "none");
  // A goal continuation uses and never manages.
  assert.equal(await got({ kind: "owner", goal }), "use");
  assert.equal(await got({ kind: "telegram", goal }), "use");
  assert.equal(
    await got({ kind: "owner", goal, result: { kind: "member-result" } }),
    "use",
  );
});
