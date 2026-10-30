import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";
import { signedInUser, upgradeStatus } from "../helpers/users.js";
import { socketPaths } from "../../server/http/socket-access.js";
import { userMayWatch } from "../../server/http/route-access.js";
import { openLive } from "../helpers/live-socket.js";

// One path per socket kind; the test fails when a kind has none. The agent chat
// probe is a real owner conversation, so a 404 means the user was refused, not
// that the conversation is missing.
const probePaths = (conversationId) => ({
  terminal: "/api/sessions/probe/terminal",
  chat: "/api/sessions/probe/chat-stream",
  "agent-chat": `/api/assistant-conversations/${conversationId}/stream`,
  browser: "/api/assistants/probe/browser-stream",
  dictation: "/api/dictation/stream",
  live: "/api/live",
});

async function ownerConversation(f) {
  const connection = f.application.providerConnections.create({
    name: "Probe",
    providerId: "openrouter",
    apiKey: "socket-probe-key",
  });
  const created = await fixtureFetch(f.url + "/api/assistants", {
    method: "POST",
    headers: { origin: f.url, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Home",
      instructions: "",
      model: { connectionId: connection.id, modelId: "openai/gpt-4.1-mini" },
    }),
  });
  assert.equal(created.status, 201);
  const assistant = await created.json();
  return f.application.assistants.store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: `agent:${assistant.runtimeAgentId}:probe`,
  });
}
// Users dictate with the owner's speech connection and open the live channel, where
// each topic checks access; every other kind needs ownership.
const admitted = new Set(["dictation", "live"]);

const opens = (f, endpoint, cookie) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(f.url.replace("http", "ws") + endpoint, {
      headers: { cookie, origin: f.url },
    });
    socket.on("open", () => {
      socket.terminate();
      resolve(true);
    });
    socket.on("unexpected-response", (_req, res) => {
      res.destroy();
      reject(new Error(`${endpoint} refused with ${res.statusCode}`));
    });
    socket.on("error", () => {});
  });

test("users are refused on every socket path", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const conversation = await ownerConversation(f);
  const probes = probePaths(conversation.id);
  const { cookie } = await signedInUser(f);
  // The owner reaches the same conversation stream the user is refused.
  assert.equal(await opens(f, probes["agent-chat"], f.cookie), true);
  assert.deepEqual(socketPaths.map((p) => p.kind).sort(), Object.keys(probes).sort());
  for (const { kind, pattern } of socketPaths) {
    const endpoint = probes[kind];
    assert.match(endpoint, pattern, kind);
    if (admitted.has(kind)) assert.equal(await opens(f, endpoint, cookie), true, kind);
    else assert.equal(await upgradeStatus(f, endpoint, cookie), 404, kind);
  }
});

test("an unregistered /api upgrade is refused", async (t) => {
  const f = await applicationFixture(t);
  const { cookie } = await signedInUser(f);
  assert.equal(await upgradeStatus(f, "/api/whatever", cookie), 404);
  assert.equal(await upgradeStatus(f, "/api/whatever", f.cookie), 404);
  assert.equal(await upgradeStatus(f, "/api/me/stream", cookie), 404);
});

test("a user cannot tell an owner topic from an unknown one on the live channel", async (t) => {
  const f = await applicationFixture(t);
  // Owner topics whose own authorize lets everyone in: the user allowlist still refuses
  // them, like the real owner topics (state, session.requests) beside them.
  for (const [name, param] of [
    ["probe.open", undefined],
    ["probe.param", /[^:]+/],
  ])
    f.application.live.define({
      name,
      param,
      mode: "state",
      authorize: () => true,
      scopeKey: () => "owner",
      read: () => ({ secret: name }),
    });
  const server = f.application.mcpServers.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp",
  });
  // An editor file the owner watches: its token was issued to him only.
  const watched = path.join(f.home, "watched.txt");
  await fs.writeFile(watched, "owner");
  const fileMeta = (
    await f.request(
      `/api/files/metadata?${new URLSearchParams({ path: watched, view: "document" })}`,
    )
  ).headers.get("x-file-watch");
  assert.match(fileMeta, /^file\.meta:[A-Za-z0-9_-]{22}$/);
  const ownerLive = openLive(f);
  await ownerLive.next((frame) => frame.type === "hello");
  // The owner reaches what the user is refused below, the job topics among them.
  for (const topic of [
    fileMeta,
    "probe.open",
    "job.tool:codex",
    "job.rea:current",
    `job.mcp-package:${server.id}`,
    "files.jobs:global",
  ]) {
    ownerLive.send({ op: "sub", topic });
    assert.equal(
      (await ownerLive.next((frame) => frame.topic === topic, 5000)).type,
      "snapshot",
      topic,
    );
  }
  // These exist for the owner; with nothing behind them their routes refuse.
  for (const topic of [
    "job.plugins:nobody",
    "job.ssh-tools:nobody",
    "job.chatgpt-login:current",
    "agent.list",
    "agent.actions:nobody",
    "agent.coding-requests:nobody",
    "agent.channels:nobody",
    "agent.reminders:nobody",
    "agent.senders:nobody",
    "session.reload:nobody",
    "files.jobs:session:nobody",
  ]) {
    ownerLive.send({ op: "sub", topic });
    const frame = await ownerLive.next((frame) => frame.topic === topic, 5000);
    assert.equal(frame.type, "error", topic);
    assert.notEqual(frame.code, "unknown-topic", topic);
  }
  // The chat delivery and AgentBus signals answer the owner like every signal topic.
  for (const topic of [
    "session.deliveries:nobody",
    "agentbus.changed",
    `agentbus.changed:${"a".repeat(64)}`,
  ]) {
    ownerLive.send({ op: "sub", topic });
    assert.equal(
      (await ownerLive.next((frame) => frame.topic === topic, 5000)).type,
      "same",
      topic,
    );
  }
  // A CLI account's sign-in state (no CLI is run here: none is installed).
  f.application.accountAuthStatus.tools = () => [];
  ownerLive.send({ op: "sub", topic: "account.auth:local-codex" });
  const auth = await ownerLive.next(
    (frame) => frame.topic === "account.auth:local-codex",
    5000,
  );
  assert.equal(auth.type, "snapshot");
  assert.equal(auth.data.state, "unknown");
  ownerLive.ws.close();
  const { cookie } = await signedInUser(f);
  // Over REST she reads no file metadata, so she is issued no token either.
  const userRead = await f.request(
    `/api/files/metadata?${new URLSearchParams({ path: watched, view: "document" })}`,
    { headers: { cookie } },
  );
  assert.notEqual(userRead.status, 200);
  assert.equal(userRead.headers.get("x-file-watch"), null);
  const live = openLive(f, cookie);
  const hello = await live.next((frame) => frame.type === "hello");
  assert.deepEqual(Object.keys(hello).sort(), ["instance", "type"]);
  const listed = [
    "probe.open",
    "probe.param:x",
    "state",
    "session.requests:x",
    "session.models:x",
    "inbox",
    "pipeline.run:x",
    "pipeline.queue:x",
    "pipeline.counts",
    "pipeline.counts:x",
    "pipeline.runs:*:*",
    "pipeline.runs:x:failed",
    "pipeline.runs.changed",
    "pipeline.runs.changed:x",
    "settings.summary",
    "connections.problems",
    "runtime.updates",
    "agent.list",
    "agent.actions:x",
    "agent.coding-requests:x",
    "agent.channels:x",
    "agent.reminders:x",
    "agent.senders:x",
    "job.operation:0000aaaa-0000-4000-8000-000000000000",
    "job.tool:codex",
    "job.rea:current",
    `job.mcp-package:${server.id}`,
    "job.plugins:local-codex",
    "job.ssh-tools:x",
    "job.chatgpt-login:current",
    "session.reload:x",
    "files.jobs:global",
    "files.jobs:session:x",
    "session.deliveries:x",
    "agentbus.changed",
    `agentbus.changed:${"a".repeat(64)}`,
    "account.auth:local-codex",
    "operations.release-sessions:1.0.0",
    "artifacts.usage",
    "artifacts.changed",
    "projects.changed",
    "project-groups.changed",
    "system.status",
    "system.status.details",
    "system.cleanup.summary",
    fileMeta,
    `file.meta:${"a".repeat(22)}`,
    "nope",
    "a".repeat(300),
    "state\u202e",
  ];
  // Every topic the hub registers, with a parameter its pattern accepts, so a new
  // topic is covered without being listed here; only her own topics are left out.
  const examples = [
    "x",
    "local-codex",
    "codex",
    "current",
    "global",
    "session:x",
    "*:*",
    "1.0.0",
    "0000aaaa-0000-4000-8000-000000000000",
    "a".repeat(64),
    "a".repeat(22),
    server.id,
  ];
  const registered = [];
  for (const [name, { definition, pattern }] of f.application.live.topics) {
    if (!pattern || definition.paramOptional) registered.push(name);
    if (!pattern) continue;
    const example = examples.find((value) => pattern.test(value));
    assert.ok(example, `no example parameter for ${name}`);
    registered.push(`${name}:${example}`);
  }
  const own = registered.filter((topic) => userMayWatch(topic));
  assert.ok(own.length > 0 && own.every((topic) => topic.startsWith("me.")));
  const topics = [
    ...new Set([...listed, ...registered.filter((topic) => !own.includes(topic))]),
  ];
  const answers = [];
  for (const topic of topics) {
    live.send({ op: "sub", topic });
    answers.push(await live.next((frame) => frame.type !== "hello"));
  }
  const [reference, ...others] = answers.map(({ topic: _topic, ...rest }) => rest);
  assert.deepEqual(reference, { type: "error", code: "unknown-topic" });
  for (const answer of others) assert.deepEqual(answer, reference);
  // Same bytes once the echoed topic is blanked: no field order or size oracle.
  const bytes = new Set(answers.map((frame) => JSON.stringify({ ...frame, topic: "" })));
  assert.equal(bytes.size, 1);
  assert.deepEqual(
    answers.map((frame) => frame.topic),
    topics.map((topic) => topic.slice(0, 200)),
  );
  live.ws.close();
  assert.ok([401, 403].includes(await upgradeStatus(f, "/api/live", "")));
});
