import test from "node:test";
import assert from "node:assert/strict";
import {
  inlineImages,
  sentText,
} from "../../server/features/assistants/runtimes/hermes/hermes-inline-images.js";
import { sendRefusal } from "../../server/features/assistants/conversation-turns.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import {
  fakeHermesHome,
  fakeHermesSupervisor,
  hermesTestRuntime,
} from "../helpers/hermes-fake-gateway.js";
import { agentId, refusal, scripted } from "../helpers/hermes-scripted.js";

// The owner's inline images (agent-attachments.js delivery) on a Hermes agent whose
// home takes them natively: each is staged in Hermes's image cache before the run is
// known and named by the submit that takes it; the user row Hermes stores with its
// image lines reads back as the text AgentPier sent.

const image = (mimeType, content = "iVBORw0K") => ({
  type: "image",
  mimeType,
  fileName: "photo",
  content,
});
const snapshot = {
  session_id: "s1",
  stored_session_id: "s1",
  revision: 0,
  execution_generation: 0,
  subscription_id: "sub-1",
  prompts: [],
};
const home = "/h/state/ap-1";
const cached = `${home}/cache/documents/native-inputs/ab`;

test("a turn's inline images are the ones Hermes takes, at most ten", () => {
  assert.deepEqual(inlineImages({ message: "x" }), []);
  assert.deepEqual(
    inlineImages({
      message: "x",
      attachments: [
        image("image/png"),
        image("image/jpeg", "/9j/"),
        image("image/gif", "R0lG"),
        image("image/webp", "UklG"),
        image("image/heic", "AAAA"),
        image("image/png", ""),
        { type: "file", mimeType: "image/png", content: "AAAA" },
      ],
    }),
    [
      { content: "iVBORw0K", ext: "png" },
      { content: "/9j/", ext: "jpg" },
      { content: "R0lG", ext: "gif" },
      { content: "UklG", ext: "webp" },
    ],
  );
  const many = { attachments: Array.from({ length: 12 }, () => image("image/png")) };
  assert.equal(inlineImages(many).length, 10);
});

test("a stored row loses only what Hermes added for images in its own home", () => {
  const sent = 'Look at this.\n\n[Files attached by the owner]\n- "attachments/a.png"';
  const homes = [home];
  assert.equal(sentText(sent, homes), sent);
  // The native route: a line per committed image, a placeholder per image part.
  const native = `${sent}\n\n[Image attached at: ${cached}/u1.png]\n[Image attached at: ${cached}/u 2.jpg]`;
  assert.equal(sentText(`${native}\n[screenshot]\n[screenshot]`, homes), sent);
  assert.equal(sentText(native, homes), sent);
  // The description route puts its notes first; their text is the model's.
  const described =
    `[The user sent an image~ Here's what I can see:\nA cat ~] on a mat.]\n` +
    `[If you need a closer look, use vision_analyze with image_url: ${cached}/u1.png ~]\n\n` +
    `[The user sent an image but I couldn't quite see it this time (>_<) You can try looking at it yourself with vision_analyze using image_url: ${cached}/u2.png]\n\n${sent}`;
  assert.equal(sentText(described, homes), sent);
  // The owner's own words stay: lines naming other files, a placeholder count that
  // does not match, and any row without the agent's home.
  for (const own of [
    `see\n\n[Image attached at: /tmp/x.png]`,
    `quote\n\n[Image attached at: ${cached}/u1.png]\n[screenshot]\n[screenshot]`,
    `just\n[screenshot]`,
    `[The user sent an image~ with vision_analyze using image_url: /tmp/x.png]\n\nhi`,
  ])
    assert.equal(sentText(own, homes), own);
  assert.equal(
    sentText(`${native}\n[screenshot]\n[screenshot]`, []),
    `${native}\n[screenshot]\n[screenshot]`,
  );
  assert.equal(sentText(undefined, homes), undefined);
});

test("a turn names its staged images; its row reads back as sent", async () => {
  const supervisor = fakeHermesSupervisor({ agentId, nativeImages: true });
  await supervisor.start();
  const runtime = hermesTestRuntime(supervisor);
  const { key } = await runtime.sessions.create({ agentId, label: "Chat" });
  const message =
    'What is on it?\n\n[Files attached by the owner]\n- "attachments/a.png"';
  await runtime.sessions.send({
    key,
    turn: { message, attachments: [image("image/png"), image("image/jpeg", "/9j/")] },
    idempotencyKey: "r1",
  });
  const frames = supervisor.peer.frames.filter((f) => /image|submit/.test(f.method));
  assert.deepEqual(
    frames.map((f) => f.method),
    ["image.attach_bytes", "image.attach_bytes", "prompt.submit"],
  );
  assert.deepEqual(
    frames.slice(0, 2).map((f) => [f.params.content_base64, f.params.ext]),
    [
      ["iVBORw0K", "png"],
      ["/9j/", "jpg"],
    ],
  );
  assert.deepEqual(frames[2].params.attachments, [
    { path: `${fakeHermesHome}/cache/images/upload_1.png`, mime: "image/png" },
    { path: `${fakeHermesHome}/cache/images/upload_2.jpg`, mime: "image/jpeg" },
  ]);
  assert.equal((await runtime.sessions.wait({ runId: "r1", waitMs: 1000 })).status, "ok");
  // A text turn names none.
  await runtime.sessions.send({ key, turn: { message: "Thanks" }, idempotencyKey: "r2" });
  await runtime.sessions.wait({ runId: "r2", waitMs: 1000 });
  const submits = supervisor.peer.frames.filter((f) => f.method === "prompt.submit");
  assert.equal("attachments" in submits[1].params, false);
  const [row] = supervisor.store.rows.values();
  assert.match(row.messages[0].text, /\[screenshot\]$/);
  const history = await runtime.sessions.history({ sessionKey: key });
  const [user, reply] = history.messages;
  assert.equal(user.text, message);
  assert.equal(user.content[0].text, message);
  assert.equal(user.entry.text, message);
  // The reply is attributed to the run whose text the row carries.
  assert.equal(reply.entry.runId, "r1");
});

test("a home that does not take images natively gets the text only", async () => {
  const supervisor = fakeHermesSupervisor({ agentId });
  await supervisor.start();
  const runtime = hermesTestRuntime(supervisor);
  const { key } = await runtime.sessions.create({ agentId, label: "Chat" });
  await runtime.sessions.send({
    key,
    turn: { message: "x", attachments: [image("image/png")] },
    idempotencyKey: "r1",
  });
  const methods = supervisor.peer.frames.map((f) => f.method);
  assert.ok(!methods.includes("image.attach_bytes"));
  const submit = supervisor.peer.frames.find((f) => f.method === "prompt.submit");
  assert.equal("attachments" in submit.params, false);
});

// A scripted gateway whose `attach` answers each image.attach_bytes (undefined: never).
async function staging(attach) {
  let attaches = 0;
  const hermes = await scripted((frame) => {
    if (frame.method === "session.create") return snapshot;
    if (frame.method === "session.resume") return { ...snapshot, subscription_id: "s2" };
    if (frame.method === "image.attach_bytes") return attach(++attaches);
    if (frame.method === "prompt.submit") return { admission_id: "ad1" };
    return {};
  });
  hermes.supervisor.nativeImages = true;
  const { key } = await hermes.sessions.create({ agentId });
  const methods = () =>
    hermes.peer.frames.map((f) => f.method).filter((m) => /image|submit|resume/.test(m));
  return { ...hermes, key, methods };
}
const turn = { message: "x", attachments: [image("image/png"), image("image/png")] };

test("an image Hermes refuses is left out; a session refusal stages again", async () => {
  const { sessions, peer, key, methods } = await staging((n) =>
    n % 2
      ? refusal("invalid_params")
      : n === 2
        ? refusal("permission_denied")
        : { attached: true, path: `/c/upload_${n}.png`, mime: "image/png" },
  );
  assert.equal((await sessions.send({ key, turn, idempotencyKey: "r" })).runId, "r");
  assert.deepEqual(methods(), [
    "image.attach_bytes",
    "image.attach_bytes",
    "session.resume",
    "image.attach_bytes",
    "image.attach_bytes",
    "prompt.submit",
  ]);
  const submit = peer.frames.find((f) => f.method === "prompt.submit");
  assert.deepEqual(submit.params.attachments, [
    { path: "/c/upload_4.png", mime: "image/png" },
  ]);
});

test("a staging failure submits nothing and fails the turn as never run", async () => {
  for (const attach of [() => undefined, () => refusal("storage_unavailable")]) {
    const { sessions, key, methods } = await staging(attach);
    const failed = await sessions.send({ key, turn, idempotencyKey: "lost" }).then(
      () => null,
      (error) => error,
    );
    assert.equal(failed?.answered, true);
    assert.equal(sendRefusal(failed), "refused");
    assert.ok(!methods().includes("prompt.submit"));
    // No run waits on the session: nothing to interrupt, the next turn goes out.
    assert.deepEqual(await sessions.abort({ key, runId: "lost" }), {
      status: "not_interrupted",
      interrupted: false,
    });
    assert.equal(
      (await sessions.send({ key, turn: { message: "y" }, idempotencyKey: "next" }))
        .runId,
      "next",
    );
  }
});

test("a home takes images natively exactly when AgentPier knows its model sees them", () => {
  const compiled = (provider) =>
    compileHome(
      desiredAgent(
        { id: "a1", runtimeAgentId: "ap-a1", revision: 1 },
        { model: { provider } },
      ),
      { workspace: "/w" },
    );
  const openRouter = (input) => ({
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "k",
    models: [{ id: "vendor/model", ...(input && { input }) }],
  });
  const endpoint = (input) => ({
    ...openRouter(input),
    baseUrl: "http://models.test/v1",
  });
  // OpenRouter models whose catalog lists image input, as endpoint models that
  // declare it: Hermes's own lookup never decides, so it never describes images.
  for (const provider of [openRouter(["text", "image"]), endpoint(["text", "image"])]) {
    const built = compiled(provider);
    const config = readHermesConfig(built.files["config.yaml"]);
    assert.equal(built.nativeImages, true);
    assert.equal(config.agent.image_input_mode, "native");
    assert.equal(config.model.supports_vision, true);
  }
  for (const provider of [openRouter(), endpoint(["text"])]) {
    const built = compiled(provider);
    const config = readHermesConfig(built.files["config.yaml"]);
    assert.equal(built.nativeImages, false);
    assert.equal(config.agent.image_input_mode, undefined);
    assert.equal(config.model.supports_vision, undefined);
  }
});
