import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { png, shareFixture, token } from "../helpers/agent-share-fixture.js";
import { generatedImageRefs } from "../../server/features/assistants/generated-images.js";
import { fromSince } from "../../server/features/users/owner-privacy.js";

const task = "44e94c4f-bb9c-4e50-af0b-65f203e10a6e";
const artifactId = "artifact_managed_image_ecfbf9d6-7803-4f03-aba7-70598bd85b98";
// The messages OpenClaw 2026.10.3 writes for an image_generate turn and its
// background completion (recorded with the pinned runtime, see the live contract).
function imageTurn(attemptId, at, { id = artifactId } = {}) {
  return [
    {
      role: "user",
      content: "Draw a grey square",
      timestamp: at,
      idempotencyKey: `${attemptId}:user`,
      __openclaw: { id: "u1" },
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "image_generate", arguments: {} }],
      timestamp: at + 1,
      __openclaw: { id: "a1", runId: attemptId },
    },
    {
      role: "toolResult",
      toolName: "image_generate",
      content: [
        {
          type: "text",
          text: `Background task started for image generation (tool:image_generate:${task}).`,
        },
      ],
      timestamp: at + 2,
      __openclaw: { id: "r1", runId: attemptId },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "It is on its way." }],
      timestamp: at + 3,
      __openclaw: { id: "a2", runId: attemptId },
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Here is the picture." },
        {
          type: "image",
          artifactId: id,
          url: "/api/chat/media/outgoing/x/y/full",
          alt: "image-1.png",
          mimeType: "image/png",
          sizeBytes: png.length,
        },
      ],
      timestamp: at + 4,
      __openclaw: {
        id: "a3",
        runId: `image_generate:tool:image_generate:${task}:ok:agent-loop`,
      },
    },
  ];
}

const canCreate = (f, profile, on = true) =>
  f.store.updateAssistant(
    profile.id,
    { capabilities: { memory: false, reminders: false, createImages: on } },
    f.store.getAssistant(profile.id).revision,
  );
// `download` answers artifacts.download (or throws), `fetch` the media read.
async function setup(
  t,
  {
    body = png,
    url = "/api/chat/media/outgoing/s/i/full?t=1",
    download = null,
    fetch = null,
  } = {},
) {
  const f = await shareFixture(t);
  canCreate(f, f.agent);
  const client = f.service.runtime.client;
  const base = client.call;
  const calls = [];
  client.call = async (method, params) => {
    if (method === "artifacts.download") {
      calls.push(params);
      if (download) return download(params);
      return { artifact: { id: params.artifactId }, url };
    }
    return base(method, params);
  };
  client.download = async (path, { maxBytes }) => {
    if (fetch) return fetch(path);
    assert.equal(path, url);
    assert.ok(maxBytes >= png.length);
    return { body, type: "image/png" };
  };
  return { ...f, calls, clock: (ms) => (f.service.now = () => ms) };
}
const shared = async (f) =>
  (await f.service.history(f.chat.id)).messages.filter((m) => m.shared);
async function until(check) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  assert.fail("timed out");
}

test("the images an image_generate completion leaves are found in raw history", () => {
  const refs = generatedImageRefs(imageTurn("attempt-1", 1000));
  assert.deepEqual(refs, [{ artifactId, name: "image-1.png", timestamp: 1004, task }]);
  // Only managed image artifacts count; other blocks and user messages never do.
  assert.deepEqual(
    generatedImageRefs([
      { role: "user", content: [{ type: "image", artifactId }] },
      { role: "assistant", content: [{ type: "image", artifactId: "../x" }] },
    ]),
    [],
  );
});

test("a generated image of a Telegram turn reaches the chat once and the paired chat", async (t) => {
  const f = await setup(t);
  const attempt = await f.turn(f.chat, "draw", {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
    inputId: "input-1",
  });
  const at = Date.now() - 5000;
  f.setHistory(imageTurn(attempt.id, at));
  const [image] = await until(async () => {
    const found = await shared(f);
    return found.length ? found : null;
  });
  assert.equal(image.role, "assistant");
  assert.deepEqual(
    image.attachments.map((x) => [x.name, x.type, x.kind]),
    [["image-1.png", "image/png", "image"]],
  );
  // Shown where the completion was written, after its words.
  assert.equal(image.timestamp, at + 4);
  const content = await f.service.attachments.content(image.attachments[0].id);
  assert.deepEqual(content.body, png);
  assert.equal(content.inline, true);
  // Read again, nothing is copied twice.
  await f.service.history(f.chat.id);
  await f.service.generatedImages.observe(f.chat);
  await delay(50);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { sessionKey: f.chat.runtimeSessionKey, artifactId });
  assert.equal((await shared(f)).length, 1);
  await f.deliver();
  const [upload] = f.api.files(token, 42);
  assert.equal(upload.method, "sendPhoto");
  assert.deepEqual(upload.params.photo.bytes, png);
  assert.equal(f.audit.at(-1).details.kind, "generated-image");
  assert.equal(f.audit.at(-1).details.channel, "telegram");
});

test("an owner's web turn gets the image in the chat only", async (t) => {
  const f = await setup(t);
  const attempt = await f.turn(f.chat, "draw-web");
  f.setHistory(imageTurn(attempt.id, Date.now() - 5000));
  await f.service.generatedImages.observe(f.chat);
  assert.equal((await shared(f)).length, 1);
  await f.deliver();
  assert.deepEqual(f.api.files(token, 42), []);
});

test("bytes that are no image, a missing artifact or a foreign location end as unavailable", async (t) => {
  for (const options of [
    { body: Buffer.from("<svg onload=alert(1)>") },
    { url: "/api/other/thing" },
    {
      download: () => {
        throw Object.assign(Error("artifact not found"), {
          answered: true,
          code: "artifact_not_found",
        });
      },
    },
    {
      fetch: () => {
        throw Object.assign(Error("too large"), { tooLarge: true });
      },
    },
  ]) {
    const f = await setup(t, options);
    const attempt = await f.turn(f.chat, "draw-bad");
    f.setHistory(imageTurn(attempt.id, Date.now() - 5000));
    await f.service.generatedImages.observe(f.chat);
    // The owner sees that an image was made but could not be kept; no retry follows.
    const [message] = await shared(f);
    assert.equal(message.unavailable, true, JSON.stringify(Object.keys(options)));
    assert.deepEqual(message.attachments, []);
    await f.service.generatedImages.observe(f.chat);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(
      [f.audit.at(-1).details.kind, f.audit.at(-1).outcome],
      ["generated-image", "failure"],
    );
  }
});

test("a passing failure is retried later, each time after a longer wait", async (t) => {
  let fail = true;
  const f = await setup(t, {
    fetch: () => {
      if (fail) throw Object.assign(Error("reset"), { code: "RPC_FAILED" });
      return { body: png, type: "image/png" };
    },
  });
  let now = Date.now();
  f.clock(now);
  const attempt = await f.turn(f.chat, "draw-retry");
  f.setHistory(imageTurn(attempt.id, now - 5000));
  await f.service.generatedImages.observe(f.chat);
  await f.service.generatedImages.observe(f.chat);
  assert.equal(f.calls.length, 1);
  f.clock((now += 61000));
  await f.service.generatedImages.observe(f.chat);
  assert.equal(f.calls.length, 2);
  // The second wait is two minutes.
  f.clock((now += 61000));
  await f.service.generatedImages.observe(f.chat);
  assert.equal(f.calls.length, 2);
  fail = false;
  f.clock((now += 61000));
  await f.service.generatedImages.observe(f.chat);
  assert.equal(f.calls.length, 3);
  assert.equal((await shared(f))[0].attachments.length, 1);
});

test("only an agent that may create images has its images copied", async (t) => {
  const f = await setup(t);
  canCreate(f, f.agent, false);
  const attempt = await f.turn(f.chat, "draw-off");
  f.setHistory(imageTurn(attempt.id, Date.now() - 5000));
  await f.service.generatedImages.observe(f.chat);
  assert.equal(f.calls.length, 0);
});

test("a member's image joins its lead's chat and the lead's Telegram chat", async (t) => {
  const f = await setup(t);
  const member = f.store.reserveMember({
    id: "member-1",
    parent: f.agent.id,
    assignment: { name: "Scout", role: "Design", assignment: "Draw" },
    snapshot: { instructions: "Draw", model: { connectionId: "c", modelId: "vision" } },
    teamId: "team-1",
    lifetime: "task",
  });
  // The lead granted it image creation (TeamStore answers this in the app).
  f.store.memberGrants = () => ({ grants: { createImages: true }, shellSsh: false });
  canCreate(f, f.agent);
  const memberChat = f.store.saveConversation({
    assistantId: member.id,
    runtimeSessionKey: "agent:member:task",
  });
  f.service.teams.requests = {
    store: { get: () => ({ parentConversationId: f.chat.id }), list: () => [] },
  };
  const attempt = await f.turn(memberChat, "lead-draw", {
    kind: "lead-request",
    requestId: "lead-request-1",
    leadAssistantId: f.agent.id,
    leadName: "Lead",
    display: "Draw",
    telegram: {
      channelId: f.channel.id,
      chatId: f.channel.chatId,
      userId: f.channel.userId,
    },
  });
  f.setHistory(imageTurn(attempt.id, Date.now() - 5000));
  await f.service.generatedImages.observe(memberChat);
  const own = (await f.service.history(memberChat.id)).messages.filter((m) => m.shared);
  const lead = (await f.service.history(f.chat.id)).messages.filter((m) => m.shared);
  assert.equal(own.length, 1);
  assert.equal(lead[0].from, "Scout");
  assert.equal(lead[0].attachments[0].kind, "image");
  await f.deliver();
  assert.deepEqual(
    f.api.files(token, 42).map((c) => c.method),
    ["sendPhoto"],
  );
});

for (const shape of ["telegram", "legacy", "off"])
  test(`a routine's run session copies into its chat, and Telegram when it delivers there (${shape})`, async (t) => {
    const f = await setup(t);
    const target = {
      channelId: f.channel.id,
      chatId: f.channel.chatId,
      userId: f.channel.userId,
    };
    // As stored now (Telegram on, off) and before chat delivery (legacy).
    const binding = {
      telegram: { id: "b1", source: { assistantId: f.agent.id }, telegram: target },
      legacy: { id: "b1", source: target },
      off: { id: "b1", source: target, telegram: null },
    }[shape];
    const agent = f.store.getAssistant(f.agent.id);
    const session = `agent:${agent.runtimeAgentId}:cron:job-1:run:run-7`;
    f.service.routines = {
      runOrigin: (profile, key) =>
        profile.id === agent.id && key === session
          ? { binding, conversation: f.chat }
          : null,
      results: { forConversation: () => [] },
    };
    f.setHistory(imageTurn("routine-run", Date.now() - 5000));
    f.service.generatedImages.observeRun({
      event: "chat",
      payload: { sessionKey: session, state: "final", runId: "run-7" },
    });
    const [image] = await until(async () => {
      const found = await shared(f);
      return found.length ? found : null;
    });
    assert.equal(image.attachments[0].kind, "image");
    assert.equal(f.calls[0].sessionKey, session);
    await f.deliver();
    assert.deepEqual(
      f.api.files(token, 42).map((c) => c.method),
      shape === "off" ? [] : ["sendPhoto"],
    );
    // Any other session is left alone.
    f.service.generatedImages.observeRun({
      event: "chat",
      payload: { sessionKey: "agent:ap-other:cron:x", state: "final" },
    });
    await delay(30);
    assert.equal(f.calls.length, 1);
  });

test("nothing is copied while AgentPier is in maintenance", async (t) => {
  const f = await setup(t);
  const attempt = await f.turn(f.chat, "draw-maintenance");
  f.setHistory(imageTurn(attempt.id, Date.now() - 5000));
  f.service.maintenance = true;
  await f.service.generatedImages.observe(f.chat);
  assert.equal(f.calls.length, 0);
  f.service.maintenance = false;
  await f.service.generatedImages.observe(f.chat);
  assert.equal(f.calls.length, 1);
});

test("a run ending in a released user's chat copies no image back", async (t) => {
  const f = await setup(t);
  const attempt = await f.turn(f.chat, "draw-released");
  f.setHistory(imageTurn(attempt.id, Date.now() - 5000));
  const ended = () =>
    f.service.runtime.client.emit("event", {
      event: "chat",
      payload: {
        sessionKey: f.chat.runtimeSessionKey,
        runId: attempt.id,
        state: "final",
      },
    });
  // Her files went with her (user-release.js): the run's end brings none back.
  f.store.updateConversation(f.chat.id, { userReleased: true });
  ended();
  await delay(50);
  assert.equal(f.calls.length, 0);
  f.store.updateConversation(f.chat.id, { userReleased: false });
  ended();
  await until(() => f.calls.length === 1);
});

test("an image and its completion answer the request that asked, also under an opt-in", async (t) => {
  const f = await setup(t);
  const attempt = await f.turn(f.chat, "draw-early");
  f.setHistory(imageTurn(attempt.id, Date.now() - 5000));
  await f.service.generatedImages.observe(f.chat);
  const history = await f.service.history(f.chat.id);
  const done = history.messages.find((m) => m.id === "a3");
  const [image] = history.messages.filter((m) => m.shared);
  assert.equal(done.imageResult, true);
  assert.equal(done.requestId, attempt.requestId);
  assert.equal(image.requestId, attempt.requestId);
  assert.equal("imageArtifact" in done, false);
  // She lets the owner read from now on: the image and its words answer an older turn.
  const since = new Date(Date.now() + 1000).toISOString();
  const later = {
    ...history,
    messages: history.messages.map((m) => ({ ...m, timestamp: Date.now() + 2000 })),
  };
  const shown = fromSince(later, since);
  assert.deepEqual(
    shown.messages.filter((m) => ["a3", image.id].includes(m.id)),
    [],
  );
});
