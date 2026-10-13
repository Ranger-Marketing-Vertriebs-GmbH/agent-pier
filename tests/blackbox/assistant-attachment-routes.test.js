import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function agentChat(t) {
  const { application, url } = await applicationFixture(t, enabledAssistants);
  const connection = application.providerConnections.create({
    name: "Attachments",
    providerId: "openrouter",
    apiKey: "attachment-route-key",
  });
  const created = await fixtureFetch(url + "/api/assistants", {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Home",
      instructions: "",
      model: { connectionId: connection.id, modelId: "openai/gpt-4.1-mini" },
    }),
  });
  assert.equal(created.status, 201);
  const assistant = await created.json();
  const assistants = application.assistants;
  const conversation = assistants.store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: `agent:${assistant.runtimeAgentId}:attachments`,
  });
  const upload = (name, body, headers = {}) =>
    fixtureFetch(
      `${url}/api/assistant-conversations/${conversation.id}/attachments?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { origin: url, "content-type": "application/octet-stream", ...headers },
        body,
      },
    );
  const workspace = path.join(assistants.config.workspaces, assistant.id);
  return { url, assistant, conversation, upload, workspace, assistants };
}

test("the attachment routes store owner uploads in the agent's workspace only", async (t) => {
  const { url, conversation, upload, workspace } = await agentChat(t);
  const stored = await upload("../../../etc/photo.png", png);
  assert.equal(stored.status, 201, await stored.clone().text());
  const file = await stored.json();
  assert.deepEqual(Object.keys(file).sort(), ["id", "kind", "name", "size", "type"]);
  assert.equal(file.name, "photo.png");
  const [saved] = fs.readdirSync(path.join(workspace, "attachments"));
  assert.match(saved, /-photo\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(workspace, "attachments", saved)), png);

  const shown = await fixtureFetch(`${url}/api/assistant-attachments/${file.id}`);
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-type"), "image/png");
  assert.equal(shown.headers.get("x-content-type-options"), "nosniff");
  assert.match(shown.headers.get("content-security-policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await shown.arrayBuffer()), png);

  // An image the agent rewrites in place is only offered as a download (R2).
  const [savedName] = fs.readdirSync(path.join(workspace, "attachments"));
  fs.writeFileSync(
    path.join(workspace, "attachments", savedName),
    Buffer.alloc(png.length, 65),
    {
      flag: "r+",
    },
  );
  const rewritten = await fixtureFetch(`${url}/api/assistant-attachments/${file.id}`);
  assert.equal(rewritten.status, 200);
  assert.equal(rewritten.headers.get("content-type"), "application/octet-stream");
  assert.match(rewritten.headers.get("content-disposition"), /^attachment; /);
  const text = await (await upload("notes.md", "# Notes\n")).json();
  const download = await fixtureFetch(`${url}/api/assistant-attachments/${text.id}`);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.match(download.headers.get("content-disposition"), /^attachment; filename\*=/);

  const policy = await fixtureFetch(
    `${url}/api/assistant-conversations/${conversation.id}/attachment-policy`,
  );
  // OpenRouter transports are compiled without image input.
  assert.deepEqual(await policy.json(), {
    imageInput: false,
    maxBytes: 10 * 1024 * 1024,
    maxFiles: 5,
  });

  const removed = await fixtureFetch(
    `${url}/api/assistant-conversations/${conversation.id}/attachments/${text.id}`,
    { method: "DELETE", headers: { origin: url } },
  );
  assert.equal(removed.status, 204);
  assert.equal(fs.readdirSync(path.join(workspace, "attachments")).length, 1);
  assert.equal(
    (await fixtureFetch(`${url}/api/assistant-attachments/${text.id}`)).status,
    404,
  );
});

test("the attachment routes refuse strangers, foreign origins, bad files and traversal", async (t) => {
  const { url, conversation, upload, workspace } = await agentChat(t);
  const target = `${url}/api/assistant-conversations/${conversation.id}/attachments?name=a.png`;
  // Not signed in.
  assert.equal(
    (
      await fetch(target, {
        method: "POST",
        headers: { origin: url, "content-type": "application/octet-stream" },
        body: png,
      })
    ).status,
    401,
  );
  assert.equal((await fetch(`${url}/api/assistant-attachments/anything`)).status, 401);
  // A foreign page cannot post into the owner's agent.
  assert.equal(
    (await upload("a.png", png, { origin: "https://foreign.invalid" })).status,
    403,
  );

  const tooLarge = await upload("big.png", Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).messageKey, "assistants.attachmentTooLarge");
  const huge = await upload("huge.png", Buffer.alloc(12 * 1024 * 1024));
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).messageKey, "assistants.attachmentTooLarge");
  const binary = await upload("tool.png", Buffer.from("MZ\x90\x00binary", "latin1"));
  assert.equal(binary.status, 415);
  assert.equal((await binary.json()).messageKey, "assistants.attachmentUnsupported");
  const svg = await upload("x.svg", "<svg onload=alert(1)></svg>");
  assert.equal(svg.status, 415);
  // Only raw uploads are accepted.
  assert.notEqual(
    (await upload("a.txt", "x", { "content-type": "text/plain" })).status,
    201,
  );
  // Names never become paths; ids never reach other files.
  for (const name of ["../../escape.txt", "..\\..\\escape.txt", "/etc/passwd.txt"]) {
    const stored = await upload(name, "x");
    assert.equal(stored.status, 201);
    assert.doesNotMatch((await stored.json()).name, /[/\\]/);
  }
  assert.equal(fs.existsSync(path.join(workspace, "escape.txt")), false);
  assert.equal(fs.existsSync(path.join(workspace, "..", "escape.txt")), false);
  for (const id of ["..%2F..%2Fassistants.sqlite", "%2e%2e", "missing"])
    assert.equal(
      (await fixtureFetch(`${url}/api/assistant-attachments/${id}`)).status,
      404,
      id,
    );
  assert.equal(
    (
      await fixtureFetch(
        `${url}/api/assistant-conversations/unknown/attachments?name=a.png`,
        {
          method: "POST",
          headers: { origin: url, "content-type": "application/octet-stream" },
          body: png,
        },
      )
    ).status,
    404,
  );
});

test("uploads are rate limited with a translated error", async (t) => {
  const { upload } = await agentChat(t);
  let limited;
  for (let n = 0; n < 70 && !limited; n++) {
    const response = await upload(`n${n}.txt`, "x");
    if (response.status === 429) limited = await response.json();
  }
  assert.equal(limited?.messageKey, "assistants.attachmentRateLimited");
});
