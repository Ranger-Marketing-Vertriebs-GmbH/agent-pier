import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { freePortRange } from "../helpers/preview-ports.js";
import { startUpstream } from "../helpers/preview-proxy-fixture.js";
import { createPreviewService } from "../../server/application/preview-wiring.js";
import { AgentShares } from "../../server/features/assistants/agent-shares.js";
import { forgetChat } from "../../server/features/assistants/chat-removal.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import {
  actions,
  bridgeTool,
  routineActions,
  personalActions,
} from "../../server/features/assistants/team-bridge-actions.js";
import { hookActions } from "../../server/features/assistants/agent-hook-bridge.js";
import { ownerRunActions } from "../../server/features/assistants/owner-runs.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import plugin, {
  toolTimeouts,
} from "../../server/features/assistants/team-plugin/index.js";

// agentpier_preview (agent-previews.js): the owner's own agents open previews of a
// server they run for the chat that asked, through the real team bridge and a real
// PreviewService on a disposable free port range.

const manifest = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../server/features/assistants/team-plugin/openclaw.plugin.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

async function previewFixture(t, { enabled = true } = {}) {
  const f = await workflowFixture(t);
  const range = await freePortRange(2);
  fs.writeFileSync(
    path.join(f.dataDir, "config.json"),
    JSON.stringify({
      previews: { enabled, portRangeStart: range.start, portRangeEnd: range.end },
    }),
  );
  // AgentPier's own port lies outside the range and is never a preview target.
  f.services.config = { dataDir: f.dataDir, port: range.start - 1 };
  const previews = createPreviewService(f.services, {
    tailscaleRun: async () => {
      throw new Error("no tailscale in tests");
    },
  });
  f.services.previews = previews;
  t.after(() => previews.shutdown());
  await previews.start();
  f.assistants.shares = new AgentShares({
    assistants: f.assistants,
    channels: f.service,
  });
  const bridge = new TeamBridge({ assistants: f.assistants, teams: {} });
  await bridge.start();
  t.after(() => bridge.close());
  const agentId = f.store.getAssistant(f.id).runtimeAgentId;
  // One call through the team bridge in a fresh turn of `origin`.
  const call = async (input, origin = { kind: "owner" }) => {
    await f.invocation(randomUUID(), origin);
    const { ticket } = bridge.prepare({
      agentId,
      sessionKey: "session",
      toolCallId: randomUUID(),
      action: "preview",
    });
    try {
      return await bridge.invoke({ ticket, action: "preview", input });
    } finally {
      for (const attempt of f.assistants.ledger.pending())
        f.assistants.ledger.transition(attempt.id, "completed");
    }
  };
  const code = (promise) =>
    promise.then(
      () => null,
      (error) => toolError(error),
    );
  const notices = () =>
    f.service.outbox.all(f.channel.id).filter((e) => e.kind === "agent-preview");
  return { ...f, range, previews, bridge, call, code, notices };
}

/** A port nothing listens on. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("the bridge serves agentpier_preview to own agents and permanent members, never routines or hooks", () => {
  assert.ok(actions.has("preview"));
  assert.equal(bridgeTool("preview"), "agentpier_preview");
  assert.ok(personalActions.has("preview"));
  assert.ok(!routineActions.has("preview"));
  assert.ok(!hookActions.has("preview"));
  // A run of the owner's chat without a turn (a background dev server's follow-up).
  assert.ok(ownerRunActions.has("preview"));
  assert.ok(manifest.contracts.tools.includes("agentpier_preview"));
  assert.equal(toolTimeouts.preview, 15000);
});

test("the plugin registers agentpier_preview with a strict schema and the preview rule", () => {
  const registered = new Map();
  plugin.register({
    pluginConfig: { url: "http://bridge.invalid", token: "test" },
    registerTool: (factory, options) => registered.set(options.name, factory),
    on() {},
  });
  assert.ok(registered.has("agentpier_preview"));
  assert.ok(!registered.has("agentpier_team_preview"));
  const tool = registered
    .get("agentpier_preview")
    .create({ agentId: "ap-x", sessionKey: "s", assertInvocationCurrent() {} });
  const p = tool.parameters;
  assert.deepEqual(p.properties.action.enum, ["open", "close", "list"]);
  assert.deepEqual(p.required, ["action"]);
  assert.equal(p.additionalProperties, false);
  assert.deepEqual([p.properties.port.minimum, p.properties.port.maximum], [1, 65535]);
  assert.equal(p.properties.label.maxLength, 80);
  assert.equal(p.properties.path.maxLength, 2048);
  assert.equal(p.properties.id.maxLength, 80);
  assert.match(tool.description, /instead of a localhost URL/);
  assert.match(tool.description, /Bind the server to 127\.0\.0\.1 or localhost/);
});

test("an own agent opens a preview for its chat and deleting the chat closes it", async (t) => {
  const f = await previewFixture(t);
  const upstream = await startUpstream(t);
  const opened = await f.call({
    action: "open",
    port: upstream.port,
    label: "Shop",
    path: "/cart",
  });
  assert.equal(opened.port, upstream.port);
  assert.equal(opened.label, "Shop");
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/cart$/);
  assert.equal(
    opened.note,
    "Give the owner this link; it opens the server through AgentPier.",
  );
  const [preview] = f.previews.list();
  assert.deepEqual(preview.owner, {
    kind: "agent",
    assistantId: f.id,
    conversationId: f.channel.conversationId,
  });
  assert.equal(preview.id, opened.id);
  // A loopback link means nothing on the owner's phone: no Telegram notice.
  assert.deepEqual(f.notices(), []);
  const listed = await f.call({ action: "list" });
  assert.deepEqual(listed.items, [
    { id: opened.id, url: opened.url, port: upstream.port, label: "Shop" },
  ]);
  const conversation = f.store.getConversation(f.channel.conversationId);
  await forgetChat(f.assistants, conversation);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.previews.list(), []);
});

test("the agent closes its preview by id or port", async (t) => {
  const f = await previewFixture(t);
  const upstream = await startUpstream(t);
  const opened = await f.call({ action: "open", port: upstream.port });
  assert.deepEqual(await f.call({ action: "close", port: upstream.port }), {
    closed: true,
  });
  assert.deepEqual(f.previews.list(), []);
  const again = await f.call({ action: "open", port: upstream.port });
  assert.notEqual(again.id, opened.id);
  await f.call({ action: "close", id: again.id });
  assert.deepEqual(f.previews.list(), []);
  // Another chat's preview is not the agent's to close here.
  const other = await f.previews.open({
    owner: {
      kind: "agent",
      assistantId: f.id,
      conversationId: f.channel.conversationId,
      project: f.id,
    },
    port: upstream.port,
  });
  f.previews.previews.get(other.id).owner.conversationId = "elsewhere";
  assert.equal(
    (await f.code(f.call({ action: "close", id: other.id }))).code,
    "PREVIEW_NOT_FOUND",
  );
});

test("a Telegram turn queues the preview link to the owner's Telegram chat", async (t) => {
  const f = await previewFixture(t);
  const upstream = await startUpstream(t);
  // The address the owner opens through Tailscale (PreviewService.previewUrl).
  f.previews.previewUrl = ({ slot, path: page = "/" }) =>
    `https://box.ts.net:${slot}${page}`;
  const origin = {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
  };
  const opened = await f.call(
    { action: "open", port: upstream.port, label: "Shop" },
    origin,
  );
  const [slot] = f.previews.list().map((p) => p.slot);
  assert.equal(opened.url, `https://box.ts.net:${slot}/`);
  const [notice] = f.notices();
  assert.equal(notice.key, `agent-preview:${opened.id}`);
  assert.equal(notice.chatId, f.channel.chatId);
  assert.ok(notice.text.includes(`https://box.ts.net:${slot}/`), notice.text);
  assert.ok(notice.text.includes("Shop"), notice.text);
  // A web turn of the same chat never reaches Telegram.
  await f.call({ action: "close", id: opened.id });
  await f.call({ action: "open", port: upstream.port, label: "Web" });
  assert.equal(f.notices().length, 1);
});

test("a failing Telegram notice never fails the call", async (t) => {
  const f = await previewFixture(t);
  const upstream = await startUpstream(t);
  f.previews.previewUrl = ({ slot }) => `https://box.ts.net:${slot}/`;
  f.service.outbox.enqueue = () => {
    throw new Error("outbox down");
  };
  const origin = {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
  };
  const opened = await f.call({ action: "open", port: upstream.port }, origin);
  assert.equal(opened.port, upstream.port);
});

test("a user's conversation and a routine run are refused", async (t) => {
  const f = await previewFixture(t);
  const upstream = await startUpstream(t);
  // Forwarded content is not the owner's turn.
  assert.equal(
    (
      await f.code(
        f.call(
          { action: "open", port: upstream.port },
          { kind: "owner", forwarded: true },
        ),
      )
    ).code,
    "FORBIDDEN",
  );
  const routine = {
    attemptId: null,
    toolCallId: "r",
    assertCurrent() {},
    routine: { binding: { id: "b" }, conversation: { id: f.channel.conversationId } },
  };
  const hook = { attemptId: null, toolCallId: "h", assertCurrent() {}, hook: {} };
  const { invokePreview } =
    await import("../../server/features/assistants/agent-previews.js");
  for (const invocation of [routine, hook])
    assert.equal(
      (
        await f.code(
          invokePreview(f.workflows, invocation, { action: "open", port: upstream.port }),
        )
      ).code,
      "FORBIDDEN",
    );
  f.store.updateConversation(f.channel.conversationId, { userId: "u1" });
  assert.equal(
    (await f.code(f.call({ action: "open", port: upstream.port }))).code,
    "FORBIDDEN",
  );
  assert.deepEqual(f.previews.list(), []);
});

test("errors reach the agent as PREVIEW_* codes", async (t) => {
  const f = await previewFixture(t);
  const closed = await closedPort();
  const refused = await f.code(f.call({ action: "open", port: closed }));
  assert.equal(refused.code, "PREVIEW_NOT_LISTENING");
  assert.equal(refused.status, 409);
  // English, for the model: never the German UI text.
  assert.match(refused.reason, new RegExp(`port ${closed}`, "i"));
  assert.doesNotMatch(refused.reason, /lauscht/);
  const forbidden = await f.code(f.call({ action: "open", port: f.range.start }));
  assert.equal(forbidden.code, "PREVIEW_PORT_FORBIDDEN");
  assert.equal(
    (await f.code(f.call({ action: "close", id: "missing" }))).code,
    "PREVIEW_NOT_FOUND",
  );
  for (const input of [
    { action: "open" },
    { action: "open", port: 0 },
    { action: "open", port: 80, extra: true },
    { action: "close" },
    { action: "close", id: "a", port: 80 },
    { action: "list", port: 80 },
    { action: "start" },
  ])
    assert.equal(
      (await f.code(f.call(input))).code,
      "INVALID_INPUT",
      JSON.stringify(input),
    );
  await f.previews.configure({ enabled: false });
  const disabled = await f.code(f.call({ action: "open", port: closed }));
  assert.equal(disabled.code, "PREVIEW_DISABLED");
  assert.match(disabled.reason, /Previews are turned off/);
});
