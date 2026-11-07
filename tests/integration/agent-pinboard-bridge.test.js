import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pinboardFixture } from "../helpers/agent-pinboard-fixture.js";
import {
  definitions,
  toolName,
  toolTimeouts,
} from "../../server/features/assistants/team-plugin/index.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import {
  grantedTools,
  routineTools,
} from "../../server/features/assistants/native-capabilities.js";
import { hookTools } from "../../server/features/assistants/agent-hook-rights.js";
import { AgentPinboard } from "../../server/features/assistants/agent-pinboard.js";
import { createAssistantServices } from "../../server/application/assistants.js";

const ready = { teamsReady: true, nativeReady: true, writeGuard: true };
const pinned = async (f, listId, name = "ep6.md") => {
  f.file(name);
  return f.pin({ action: "pin", listId, path: name });
};

test("the plugin registers agentpier_pinboard with a 30 s timeout", () => {
  assert.ok(definitions.pinboard);
  assert.equal(toolName("pinboard"), "agentpier_pinboard");
  assert.equal(toolTimeouts.pinboard, 30000);
  assert.deepEqual(definitions.pinboard.parameters.required, ["action"]);
});

test("a turn pins through the bridge", async (t) => {
  const f = await pinboardFixture(t);
  // A live turn: the call carries the attempt's run id.
  const { attemptId } = await f.invocation(randomUUID(), { kind: "owner" });
  const { list } = await f.pin({ action: "create_list", title: "Episodes" }, attemptId);
  f.file("ep6.md");
  const result = await f.pin(
    { action: "pin", listId: list.id, path: "ep6.md" },
    attemptId,
  );
  assert.equal(result.status, "pinned");
  assert.equal((await f.pin({ action: "list" }, attemptId)).lists.length, 1);
});

test("a routine run pins; the card goes to the list's origin chat", async (t) => {
  const f = await pinboardFixture(t);
  const body = {
    ...f.store.storedAssistant(f.id),
    capabilities: { memory: true, reminders: true },
  };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  const conversation = f.store.getConversation(f.channel.conversationId);
  const runKey = `agent:${f.agentId}:cron:job-1:run:run-7`;
  f.assistants.routines = {
    runOrigin: (agent, key) =>
      agent.id === f.id && key === runKey
        ? {
            binding: { id: "b1", source: { assistantId: f.id }, telegram: null },
            conversation,
          }
        : null,
    writable: () => false,
  };
  await f.turn({ kind: "owner" });
  const { list } = await f.pin({ action: "create_list", title: "Episodes" });
  f.file("routine.md");
  const result = await f.pin(
    { action: "pin", listId: list.id, path: "routine.md" },
    "run-7",
    runKey,
  );
  assert.equal(result.status, "pinned");
  assert.ok(f.pinboard.store.changesFor(conversation.id).length > 0);
});

test("a hook run pins from the workspace", async (t) => {
  const f = await pinboardFixture(t);
  await f.turn({ kind: "owner" });
  const { list } = await f.pin({ action: "create_list", title: "Episodes" });
  const conversation = f.store.getConversation(f.channel.conversationId);
  const origin = {
    event: { id: "event-1" },
    hook: { id: "h1", name: "Mail" },
    effective: { folders: {}, coding: false },
    conversation,
  };
  const hookKey = `agent:${f.agentId}:cron:job-2:run:run-8`;
  f.assistants.routines = {
    hooks: {
      runOrigin: (agent, key) => (key === hookKey ? origin : null),
      events: { byJob: () => ({ ...origin.event, assistantId: f.id, hookId: "h1" }) },
    },
  };
  f.file("hook.md");
  const result = await f.pin(
    { action: "pin", listId: list.id, path: "hook.md" },
    "run-8",
    hookKey,
  );
  assert.equal(result.status, "pinned");
  // The card lands in the list's origin chat, under the hook's event.
  const [card] = f.pinboard.store
    .changesFor(conversation.id)
    .filter((change) => change.requestId === "hook:event-1");
  assert.deepEqual(card.names, ["hook.md"]);
  assert.equal(card.added, 1);
});

test("a permanent member pins onto its own board through the bridge", async (t) => {
  const f = await pinboardFixture(t);
  const body = {
    ...f.store.storedAssistant(f.id),
    teamMemberId: "team-1",
    lifetime: "permanent",
  };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  const { attemptId } = await f.invocation(randomUUID(), { kind: "owner" });
  const { list } = await f.pin({ action: "create_list", title: "Review" }, attemptId);
  f.file("review.md");
  const result = await f.pin(
    { action: "pin", listId: list.id, path: "review.md" },
    attemptId,
  );
  assert.equal(result.status, "pinned");
  assert.equal(f.pinboard.store.lists(f.id)[0].entries[0].name, "review.md");
});

test("an owner run without a turn may pin", async (t) => {
  const f = await pinboardFixture(t);
  await f.turn({ kind: "owner" });
  await f.eventTurn();
  const { list } = await f.pin({ action: "create_list", title: "Episodes" });
  assert.equal((await pinned(f, list.id)).status, "pinned");
});

test("a restricted user's turn is refused at the bridge too", async (t) => {
  const f = await pinboardFixture(t, {
    userAccess: {
      mode: "shared",
      members: [{ userId: "anna", level: "chat" }],
      released: [],
    },
  });
  f.store.updateConversation(f.channel.conversationId, { userId: "anna" });
  await f.invocation(randomUUID(), { kind: "user", userId: "anna" });
  await assert.rejects(
    f.pin({ action: "list" }),
    (error) => toolError(error).code === "PINBOARD_OWNER_ONLY",
  );
});

test("a user's own agent is refused at the bridge", async (t) => {
  const f = await pinboardFixture(t, {
    userAccess: {
      mode: "own",
      members: [{ userId: "anna", level: "chat" }],
      released: [],
    },
  });
  f.store.updateConversation(f.channel.conversationId, { userId: "anna" });
  await f.invocation(randomUUID(), { kind: "user", userId: "anna" });
  await assert.rejects(
    f.pin({ action: "list" }),
    (error) => toolError(error).code === "PINBOARD_OWNER_ONLY",
  );
  assert.deepEqual(f.pinboard.store.lists(f.id), []);
});

test("the tool is granted to live agents and members, not to a user's own agent", () => {
  const holds = (record) =>
    grantedTools(desiredAgent({ runtimeAgentId: "ap-x", ...record }).tools, ready);
  const owner = { id: "a1", name: "Agent", capabilities: { memory: true } };
  assert.ok(holds(owner).includes("agentpier_pinboard"));
  assert.ok(
    holds({ ...owner, teamMemberId: "lead", lifetime: "permanent" }).includes(
      "agentpier_pinboard",
    ),
  );
  assert.ok(
    !holds({
      ...owner,
      userAccess: { mode: "own", members: [{ userId: "anna", level: "chat" }] },
    }).includes("agentpier_pinboard"),
  );
  assert.ok(routineTools.includes("agentpier_pinboard"));
  const none = {};
  assert.ok(
    hookTools(
      { research: false, folders: {}, shell: "off", sshHosts: [] },
      none,
    ).includes("agentpier_pinboard"),
  );
});

// The production graph (server/application/assistants.js): the bridge reaches the
// pinboard that createAssistantServices wires onto the connected assistants.
test("the production graph routes a bridge invoke to graph.assistants.pinboard", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pinboard-wiring-")),
  );
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const services = createAssistantServices({
    config: { dataDir },
    providerConnections: { list: () => [] },
  });
  t.after(async () => {
    await services.assistantChannels?.close().catch(() => {});
    await services.assistantTeams?.close().catch(() => {});
    await services.assistantWorkflows?.close().catch(() => {});
    await services.assistants?.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { assistants } = services;
  const { bridge } = services.assistantTeams;
  assert.ok(assistants.pinboard instanceof AgentPinboard);
  const agent = assistants.store.createAssistant({
    name: "Agent",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = assistants.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "session",
  });
  const list = assistants.pinboard.store.createList(
    agent.id,
    { title: "Episodes" },
    new Date().toISOString(),
  );
  // A ticket as prepare would issue it for an owner run of the chat; the turn checks
  // are not under test here, the dispatch to the real pinboard is.
  bridge.valid = (record) => record;
  bridge.tickets.set("t1", {
    action: "pinboard",
    expires: Date.now() + 30000,
    owner: { conversationId: chat.id },
    sessionKey: "session",
    toolCallId: "call-1",
  });
  const answer = await bridge.invoke({
    ticket: "t1",
    action: "pinboard",
    input: { action: "list" },
  });
  assert.equal(answer.status, "ok");
  assert.deepEqual(
    answer.lists.map(({ id, title }) => ({ id, title })),
    [{ id: list.id, title: "Episodes" }],
  );
});
