import test from "node:test";
import assert from "node:assert/strict";
import {
  inlineImages,
  sentText,
} from "../../server/features/assistants/runtimes/hermes/hermes-inline-images.js";
import {
  fakeHermesSupervisor,
  hermesTestRuntime,
} from "../helpers/hermes-fake-gateway.js";
import { agentId, refusal, scripted } from "../helpers/hermes-scripted.js";

// The owner's inline images (agent-attachments.js delivery) on a Hermes agent: each is
// staged in Hermes's image cache and named by the submit that takes it, and the user
// row Hermes stores with its image lines reads back as the text AgentPier sent.

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

test("a stored user row reads back without what Hermes added for its images", () => {
  const sent = 'Look at this.\n\n[Files attached by the owner]\n- "attachments/a.png"';
  assert.equal(sentText(sent), sent);
  // The gateway's row: one line per committed image, one placeholder per image part.
  assert.equal(
    sentText(
      `${sent}\n\n[Image attached at: /h/cache/documents/native-inputs/ab/upload_1.png]\n[Image attached at: /h/x y/upload_2.jpg]\n[screenshot]\n[screenshot]`,
    ),
    sent,
  );
  // Its other views: image references, and data URLs when unverified.
  assert.equal(sentText(`${sent}\n@image:"/Users/x/Application Support/u.png"`), sent);
  assert.equal(
    sentText(`${sent}\n@image:/h/u.png\ndata:image/png;base64,iVBORw0K==`),
    sent,
  );
  // The owner's own words keep a reference that does not end the row.
  const own = "@image:/x.png is what I mean\nsee above";
  assert.equal(sentText(own), own);
  assert.equal(sentText(undefined), undefined);
});

test("a turn names its staged images; its row reads back as sent", async () => {
  const supervisor = fakeHermesSupervisor({ agentId });
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
    { path: "/home/cache/images/upload_1.png", mime: "image/png" },
    { path: "/home/cache/images/upload_2.jpg", mime: "image/jpeg" },
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

test("an image Hermes refuses is left out; a session refusal stages again", async () => {
  let attaches = 0;
  let submits = 0;
  const { peer, sessions } = await scripted((frame) => {
    if (frame.method === "session.create") return snapshot;
    if (frame.method === "session.resume") return { ...snapshot, subscription_id: "s2" };
    if (frame.method === "image.attach_bytes") {
      attaches++;
      if (attaches % 2) return refusal("invalid_params");
      if (attaches === 2) return refusal("permission_denied");
      return { attached: true, path: `/c/upload_${attaches}.png`, mime: "image/png" };
    }
    if (frame.method === "prompt.submit")
      return ++submits === 1 ? refusal("session_busy") : { admission_id: "ad1" };
    return {};
  });
  const { key } = await sessions.create({ agentId });
  const turn = { message: "x", attachments: [image("image/png"), image("image/png")] };
  // The second image's session refusal attaches the session and stages again; the
  // first image is refused both times; the busy refusal ends the send.
  await assert.rejects(
    sessions.send({ key, turn, idempotencyKey: "busy" }),
    (e) => e.answered && e.code === "BUSY",
  );
  assert.deepEqual(
    peer.frames.map((f) => f.method).filter((m) => m !== "client.capabilities"),
    [
      "session.create",
      "image.attach_bytes",
      "image.attach_bytes",
      "session.resume",
      "image.attach_bytes",
      "image.attach_bytes",
      "prompt.submit",
    ],
  );
  const submit = peer.frames.find((f) => f.method === "prompt.submit");
  assert.deepEqual(submit.params.attachments, [
    { path: "/c/upload_4.png", mime: "image/png" },
  ]);
});
