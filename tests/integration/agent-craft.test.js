import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { agentProjectFixture } from "../helpers/agent-project-fixture.js";
import { rebuildsFixture } from "../helpers/craft-rebuilds-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { loopGuard } from "../../server/features/assistants/agent-loop-guard.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import {
  actions,
  bridgeTool,
  routineActions,
} from "../../server/features/assistants/team-bridge-actions.js";
import { ownerRunActions } from "../../server/features/assistants/owner-runs.js";
import { hookActions } from "../../server/features/assistants/agent-hook-bridge.js";
import { lockedCall } from "../../server/features/users/user-agent-lock.js";
import plugin, {
  toolTimeouts,
} from "../../server/features/assistants/team-plugin/index.js";
import { craftStackChoices } from "../../server/features/assistants/team-plugin/craft-tool.js";
import { craftStacks } from "../../server/features/craft/craft-stacks.js";

// agentpier_craft (craft/agent-craft.js): the owner's own agents start Craft Anything
// rebuilds with the owner's defaults and read the status of their own; questions stay
// with the owner.

const statusKeys = [
  "folder",
  "id",
  "link",
  "name",
  "note",
  "openQuestions",
  "projectId",
  "status",
  "statusLabel",
  "step",
].sort();

/** The workflows with a real rebuild supervisor over the fake Craft Anything. */
async function craftFixture(t, { installed = true } = {}) {
  const f = await agentProjectFixture(t);
  const r = rebuildsFixture(t, { installed });
  f.services.craftRebuilds = r.rebuilds;
  f.services.craft = { state: () => ({ installed }) };
  const tool = (inv, input) => f.workflows.craft.invoke(inv, input);
  const call = async (input, origin) =>
    tool(await f.invocation(randomUUID(), origin), input);
  return { ...f, r, tool, call };
}

test("the bridge serves agentpier_craft like agentpier_project", () => {
  assert.ok(actions.has("craft"));
  assert.equal(bridgeTool("craft"), "agentpier_craft");
  assert.ok(ownerRunActions.has("craft"));
  assert.ok(!routineActions.has("craft"));
  assert.ok(!hookActions.has("craft"));
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../server/features/assistants/team-plugin/openclaw.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.ok(manifest.contracts.tools.includes("agentpier_craft"));
  assert.ok(toolTimeouts.craft > 60000, "longer than the supervisor's start");
  const userAccess = { mode: "own", members: [{ userId: "u1", level: "chat" }] };
  assert.equal(lockedCall({ id: "a", userAccess }, "agentpier_craft"), true);
  assert.equal(lockedCall({ id: "a" }, "agentpier_craft"), false);
});

test("the plugin registers agentpier_craft with a strict schema and the pinned stacks", () => {
  assert.deepEqual(craftStackChoices, [...craftStacks]);
  const registered = new Map();
  plugin.register({
    pluginConfig: { url: "http://bridge.invalid", token: "test" },
    registerTool: (factory, options) => registered.set(options.name, factory),
    on() {},
  });
  assert.ok(!registered.has("agentpier_team_craft"));
  const tool = registered
    .get("agentpier_craft")
    .create({ agentId: "ap-x", sessionKey: "s", assertInvocationCurrent() {} });
  const p = tool.parameters;
  assert.deepEqual(p.properties.action.enum, ["start", "status"]);
  assert.deepEqual(p.required, ["action"]);
  assert.equal(p.additionalProperties, false);
  assert.equal(p.properties.request.maxLength, 8000);
  assert.deepEqual(p.properties.stack.enum, [...craftStacks]);
  assert.match(tool.description, /owner answers every question/);
});

test("start runs a rebuild with the owner's defaults; a retry returns the same one", async (t) => {
  const f = await craftFixture(t);
  await f.r.rebuilds.saveSettings({ accountId: "acc-b", mode: "deep", autoMode: true });
  const inv = await f.invocation(randomUUID());
  const input = { action: "start", request: "A counter app", stack: "Python" };
  const started = await f.tool(inv, input);
  assert.deepEqual(Object.keys(started).sort(), statusKeys);
  assert.equal(started.link, `/craft/${started.id}`);
  assert.equal(started.openQuestions, 0);
  const view = f.r.rebuilds.get(started.id);
  assert.equal(view.source, "agent");
  assert.equal(view.accountId, "acc-b");
  assert.equal(view.mode, "deep");
  assert.equal(view.autoMode, true);
  assert.equal(view.stack, "Python");
  assert.equal(view.target, "-");
  assert.ok(f.r.rebuilds.requestIdOf(started.id).startsWith(`${f.id}:`));
  // The same tool call again (a plugin retry) starts nothing new.
  const retry = await f.tool(inv, input);
  assert.equal(retry.id, started.id);
  assert.equal(f.r.rebuilds.list().length, 1);
  // A new call starts a second rebuild.
  const second = await f.call({ action: "start", request: "A counter app" });
  assert.notEqual(second.id, started.id);
  assert.equal(f.r.rebuilds.list().length, 2);
  const audits = f.audit.filter((e) => e.details.kind === "agent-craft");
  assert.equal(audits.length, 2);
  assert.deepEqual(audits[0], {
    action: "project.created",
    resourceType: "assistant",
    resourceId: f.id,
    projectId: started.projectId,
    source: "agent",
    outcome: "success",
    details: { kind: "agent-craft", rebuildId: started.id },
  });
  assert.ok(!JSON.stringify(f.audit).includes("counter"));
});

test("status reads only the agent's own rebuilds and never the questions", async (t) => {
  const f = await craftFixture(t);
  const started = await f.call({ action: "start", request: "A clock" });
  const status = await f.call({ action: "status", id: started.id });
  assert.deepEqual(Object.keys(status).sort(), statusKeys);
  assert.equal(status.id, started.id);
  const owner = await f.r.rebuilds.start({ request: "Owner's" }, { source: "owner" });
  const session = await f.r.rebuilds.start(
    { request: "Session's", requestId: `${f.id}:x` },
    { source: "session" },
  );
  for (const id of [owner.id, session.id, "missing"])
    assert.equal(
      await f.code(f.call({ action: "status", id })),
      "CRAFT_REBUILD_NOT_FOUND",
      id,
    );
  // Another agent's rebuild is not this agent's.
  const other = await f.r.rebuilds.start(
    { request: "Other's", requestId: "other-agent:abc" },
    { source: "agent" },
  );
  assert.equal(
    await f.code(f.call({ action: "status", id: other.id })),
    "CRAFT_REBUILD_NOT_FOUND",
  );
});

test("invalid input, refusals and a missing Craft Anything answer with stable codes", async (t) => {
  const f = await craftFixture(t);
  for (const input of [
    { action: "start" },
    { action: "start", request: "   " },
    { action: "start", request: "X", target: "relative/path" },
    { action: "start", request: "X", stack: "COBOL" },
  ])
    assert.equal(
      await f.code(f.call(input)),
      "CRAFT_REBUILD_INVALID_INPUT",
      JSON.stringify(input),
    );
  for (const input of [
    { action: "start", request: "X", accountId: "acc-a" },
    { action: "start", request: "X", autoMode: true },
    { action: "status" },
    { action: "status", id: 1 },
    { action: "answer", id: "q" },
    null,
  ])
    assert.equal(await f.code(f.call(input)), "INVALID_INPUT", JSON.stringify(input));
  assert.equal(f.r.rebuilds.list().length, 0);
  // The English reason of an invalid target.
  const error = await f.call({ action: "start", request: "X", target: "nope" }).then(
    () => null,
    (e) => toolError(e),
  );
  assert.match(error.reason, /web address|absolute path/i);
  // A default projects folder that is not writable.
  fs.chmodSync(f.r.projectsDir, 0o500);
  assert.equal(
    await f.code(f.call({ action: "start", request: "Blocked" })),
    "PROJECT_FOLDER_UNAVAILABLE",
  );
  fs.chmodSync(f.r.projectsDir, 0o700);
  const bare = await craftFixture(t, { installed: false });
  const missing = await bare.call({ action: "start", request: "X" }).then(
    () => null,
    (e) => toolError(e),
  );
  assert.equal(missing.code, "CRAFT_NOT_INSTALLED");
  assert.match(missing.reason, /tell the owner/);
  delete bare.services.craftRebuilds;
  bare.services.craft = { state: () => ({ installed: true }) };
  assert.equal(
    await bare.code(bare.call({ action: "status", id: "x" })),
    "CRAFT_NOT_INSTALLED",
  );
});

test("only the owner's chat of an eligible agent starts rebuilds", async (t) => {
  const f = await craftFixture(t);
  const start = { action: "start", request: "A clock" };
  for (const origin of [{ kind: "owner", forwarded: true }, { kind: "lead-request" }])
    assert.equal(await f.code(f.call(start, origin)), "FORBIDDEN", origin.kind);
  for (const field of ["hook", "routine"]) {
    const inv = await f.invocation(randomUUID());
    inv[field] = { id: "x" };
    assert.equal(await f.code(f.tool(inv, start)), "FORBIDDEN", field);
  }
  f.services.assistantTelegramSenders = { connected: (id) => id === f.id };
  assert.equal(await f.code(f.call(start)), "PROJECT_NOT_ELIGIBLE");
  delete f.services.assistantTelegramSenders;
  f.setAgent("teamMemberId", "member");
  f.setAgent("lifetime", "permanent");
  assert.equal(await f.code(f.call(start)), "PROJECT_NOT_ELIGIBLE");
  assert.equal(f.r.rebuilds.list().length, 0);
  f.setAgent("teamMemberId", null);
  // A run of the owner's chat without a turn (owner-runs.js).
  const run = {
    ...(await f.invocation(randomUUID())),
    attemptId: null,
    ownerRun: { conversationId: f.channel.conversationId },
  };
  const started = await f.tool(run, start);
  assert.equal(f.r.rebuilds.get(started.id).source, "agent");
});

test("a call through the team bridge starts a rebuild and reads its status", async (t) => {
  const f = await craftFixture(t);
  const bridge = new TeamBridge({ assistants: f.assistants, teams: {} });
  await bridge.start();
  t.after(() => bridge.close());
  const agentId = f.store.getAssistant(f.id).runtimeAgentId;
  const call = async (input) => {
    await f.invocation();
    const { ticket } = bridge.prepare({
      agentId,
      sessionKey: "session",
      toolCallId: randomUUID(),
      action: "craft",
    });
    const result = await bridge.invoke({ ticket, action: "craft", input });
    for (const attempt of f.assistants.ledger.pending())
      f.assistants.ledger.transition(attempt.id, "completed");
    return result;
  };
  const started = await call({ action: "start", request: "A clock" });
  assert.equal(f.r.rebuilds.get(started.id).source, "agent");
  const status = await call({ action: "status", id: started.id });
  assert.equal(status.id, started.id);
});

test("the audit keeps a rebuild's id only for agent-craft records", () => {
  const id = randomUUID();
  const event = (kind, rebuildId) =>
    auditEvent({
      action: "project.created",
      resourceType: "assistant",
      resourceId: "agent-1",
      source: "agent",
      outcome: "success",
      details: { kind, rebuildId, request: "secret" },
    }).details;
  assert.deepEqual(event("agent-craft", id), { kind: "agent-craft", rebuildId: id });
  assert.deepEqual(event("agent-craft", "../x"), { kind: "agent-craft" });
  assert.deepEqual(event("agent-project", id), { kind: "agent-project" });
});

test("an agent's rebuild targets a web address or nothing, never a local path", async (t) => {
  const f = await craftFixture(t);
  for (const target of ["/Users/owner/.ssh", f.r.dataDir, " /etc "]) {
    const error = await f.call({ action: "start", request: "X", target }).then(
      () => null,
      (e) => toolError(e),
    );
    assert.equal(error.code, "CRAFT_REBUILD_INVALID_INPUT", target);
    assert.match(error.reason, /never a local path/);
  }
  assert.equal(f.r.rebuilds.list().length, 0);
  const url = await f.call({ action: "start", request: "X", target: "https://a.test/" });
  assert.equal(f.r.rebuilds.get(url.id).target, "https://a.test/");
  const none = await f.call({ action: "start", request: "Y", target: "-" });
  assert.equal(f.r.rebuilds.get(none.id).target, "-");
  // Sessions and the owner keep paths.
  for (const source of ["session", "owner"]) {
    const view = await f.r.rebuilds.start(
      { request: source, target: "/tmp/app" },
      { source },
    );
    assert.equal(view.target, "/tmp/app", source);
  }
});

test("a user agent and a user's conversation are refused at the service", async (t) => {
  const f = await craftFixture(t);
  const start = { action: "start", request: "A clock" };
  f.setAgent("userAccess", { mode: "shared", userIds: ["u"] });
  assert.equal(await f.code(f.call(start)), "FORBIDDEN");
  assert.equal(await f.code(f.call({ action: "status", id: "x" })), "FORBIDDEN");
  f.setAgent("userAccess", null);
  f.assistants.store.db
    .prepare("UPDATE conversations SET body=json_set(body,'$.userId',?) WHERE id=?")
    .run("u", f.channel.conversationId);
  assert.equal(await f.code(f.call(start)), "FORBIDDEN");
  assert.equal(f.r.rebuilds.list().length, 0);
});

test("a retry while the first start runs joins it and charges the loop guard once", async (t) => {
  const f = await craftFixture(t);
  const guard = loopGuard(f.assistants.store);
  const take = guard.take.bind(guard);
  let taken = 0;
  guard.take = (id) => {
    taken += 1;
    return take(id);
  };
  const inv = await f.invocation(randomUUID());
  const input = { action: "start", request: "A counter app" };
  const [first, retry] = await Promise.all([f.tool(inv, input), f.tool(inv, input)]);
  assert.equal(retry.id, first.id);
  assert.equal(taken, 1);
  assert.equal(f.r.rebuilds.list().length, 1);
  assert.equal(f.workflows.craft.starting.size, 0);
});
