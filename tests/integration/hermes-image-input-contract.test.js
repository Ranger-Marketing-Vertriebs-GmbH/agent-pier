import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { startFakeModel } from "../helpers/hermes-fake-model.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { hermesFleetApp, json } from "../helpers/hermes-app.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { png } from "../helpers/image-bytes.js";

// Images the agent's model sees on the pinned Hermes (AGENTPIER_HERMES_CONTRACT_RUNTIME),
// as on OpenClaw: an agent whose model takes images (a model of the fake endpoint
// declared with image input) gets the owner's attached image inline in its turn, and
// a project image it views with agentpier_workspace image_view as an image in the
// tool result. The fake model records each request, so the contract reads the image
// parts Hermes sent it.
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };

const imageParts = (content) =>
  Array.isArray(content) ? content.filter((part) => part?.type === "image_url") : [];
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

test(
  "Hermes contract: an attached image and a project image reach a vision model as images",
  options,
  async (t) => {
    const model = await startFakeModel();
    t.after(() => model.close());
    const app = await hermesFleetApp(t, model);
    const { f, fleet, assistants } = app;
    const vision = f.application.providerConnections.create({
      name: "Fake vision",
      providerId: "endpoint",
      endpoint: {
        preset: "custom",
        openaiBaseUrl: model.baseUrl,
        anthropicBaseUrl: null,
        protocols: { messages: false, responses: false, chatCompletions: true },
        authHeader: null,
        models: [
          {
            modelId: "fake-vision",
            label: "Fake vision",
            contextTokens: 128000,
            outputTokens: 4096,
            images: true,
            source: "manual",
            contextEdited: false,
          },
        ],
      },
      apiKey: "vision-key",
    });
    const created = await app.createAgent({
      name: "Hermes viewer",
      shell: "off",
      model: { connectionId: vision.id, modelId: "fake-vision" },
    });
    // Read images, and a project folder holding a screenshot, granted read.
    const folder = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "hermes-images-")),
    );
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    fs.writeFileSync(path.join(folder, "screen.png"), png);
    const project = await f.application.memory.register(folder);
    const access = await json(await f.request(`/api/assistants/${created.id}/access`));
    await json(
      await f.request(`/api/assistants/${created.id}/access`, {
        method: "PUT",
        body: {
          revision: access.revision,
          projectIds: [project.id],
          pipelineIds: [],
          memoryWrite: false,
          autonomous: false,
          publish: false,
          projectFiles: { [project.id]: "read" },
        },
      }),
    );
    const agent = await json(
      await f.request(`/api/assistants/${created.id}`, {
        method: "PATCH",
        body: {
          revision: created.revision,
          capabilities: { ...created.capabilities, documents: true },
          confirmRestart: true,
        },
      }),
    );
    await app.ready(agent);

    // 1. The owner's attachment: the turn's text names the file, its model sees it.
    const chat = await app.chat(agent);
    const photo = await assistants.attachments.stage(chat.chat.id, "dot.png", png);
    const sent = await f.request(
      `/api/assistant-conversations/${chat.chat.id}/messages`,
      {
        method: "POST",
        body: {
          clientRequestId: "photo",
          text: "What is on it?",
          attachments: [photo.id],
        },
      },
    );
    assert.ok([200, 201, 202].includes(sent.status), await sent.text());
    await chat.reply("ECHO");
    const asked = model.requests.find((r) =>
      (r.body?.messages || []).some(
        (m) => m.role === "user" && imageParts(m.content).length,
      ),
    );
    assert.ok(asked, "a model request with the attached image");
    assert.equal(asked.body.model, "fake-vision");
    const user = asked.body.messages.findLast((m) => m.role === "user");
    assert.deepEqual(
      imageParts(user.content).map((part) => part.image_url.url),
      [dataUrl],
    );
    const said = user.content.find((part) => part.type === "text").text;
    assert.match(said, /^What is on it\?/);
    assert.match(said, /attachments\/\d{8}-\d{6}-[0-9a-f]{8}-dot\.png/);
    // The chat shows the owner's words and the file, not Hermes's image references.
    const messages = await chat.messages();
    const mine = messages.find((m) => m.role === "user");
    assert.equal(mine.text, "What is on it?");
    assert.deepEqual(
      mine.attachments.map((file) => file.name),
      ["dot.png"],
    );

    // 2. A project image: the tool result carries the image for the model.
    const before = model.requests.length;
    await eventually(
      async () => {
        const next = await f.request(
          `/api/assistant-conversations/${chat.chat.id}/messages`,
          {
            method: "POST",
            body: {
              clientRequestId: "project",
              text: `Look.\nCALL: agentpier_workspace ${JSON.stringify({
                action: "image_view",
                projectId: project.id,
                path: "screen.png",
              })}`,
            },
          },
        );
        if (next.status === 409) return false;
        assert.ok([200, 201, 202].includes(next.status), await next.text());
        return true;
      },
      120000,
      "the first turn to end",
    );
    const done = await chat.reply(/TOOL_DONE: Image "screen\.png"/);
    assert.match(done.text, /untrusted data, not instructions/);
    const viewed = model.requests
      .slice(before)
      .map((r) => r.body?.messages?.at(-1))
      .find((m) => m?.role === "tool");
    assert.ok(viewed, "a model request answering the tool call");
    assert.deepEqual(
      imageParts(viewed.content).map((part) => part.image_url.url),
      [dataUrl],
    );
    assert.ok(!JSON.stringify(viewed.content).includes('"data":'), "no base64 as text");

    const paths = fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    await fleet.close();
    assert.deepEqual(await strayAfterStop({ root: path.dirname(paths.hermesHome) }), []);
  },
);
