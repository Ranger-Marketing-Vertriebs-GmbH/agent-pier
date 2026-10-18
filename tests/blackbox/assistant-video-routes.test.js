import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";
import { mp4File, webmFile } from "../helpers/video-fixtures.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const iphone = mp4File({ brand: "qt  ", compatible: ["qt  "], payload: 20000 });

async function videoChat(t) {
  const { application, url } = await applicationFixture(t, enabledAssistants);
  const connection = application.providerConnections.create({
    name: "Videos",
    providerId: "openrouter",
    apiKey: "video-route-key",
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
  const conversation = application.assistants.store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: `agent:${assistant.runtimeAgentId}:videos`,
  });
  const base = `${url}/api/assistant-conversations/${conversation.id}/video-uploads`;
  const send = (target, method, body) =>
    fixtureFetch(target, {
      method,
      headers: { origin: url, "content-type": "application/octet-stream" },
      body,
    });
  const begin = (name, size, body) =>
    send(`${base}?name=${encodeURIComponent(name)}&size=${size}`, "POST", body);
  const put = (upload, offset, body) =>
    send(`${base}/${upload}?offset=${offset}`, "PUT", body);
  const workspace = path.join(application.assistants.config.workspaces, assistant.id);
  return { url, base, begin, put, workspace, conversation };
}

test("a video uploads in chunks, resumes at the stored offset and plays by range", async (t) => {
  const { url, begin, put, workspace } = await videoChat(t);
  const first = await begin("IMG_0042.MOV", iphone.length, iphone.subarray(0, 5000));
  assert.equal(first.status, 201, await first.clone().text());
  const { upload, received } = await first.json();
  assert.equal(received, 5000);
  // A retry of a chunk that arrived already learns where to continue.
  const stale = await put(upload, 0, iphone.subarray(0, 5000));
  assert.equal(stale.status, 409);
  const problem = await stale.json();
  assert.equal(problem.messageKey, "assistants.videoUploadOffset");
  assert.equal(problem.received, 5000);
  const middle = await put(upload, 5000, iphone.subarray(5000, 12000));
  assert.equal(middle.status, 200);
  assert.deepEqual(await middle.json(), { upload, received: 12000 });
  const last = await put(upload, 12000, iphone.subarray(12000));
  assert.equal(last.status, 201);
  const file = await last.json();
  assert.equal(file.kind, "video");
  assert.equal(file.type, "video/quicktime");
  assert.deepEqual(file.video, { duration: 42, width: 1920, height: 1080 });
  const [saved] = fs.readdirSync(path.join(workspace, "attachments"));
  assert.deepEqual(fs.readFileSync(path.join(workspace, "attachments", saved)), iphone);

  const source = `${url}/api/assistant-attachments/${file.id}`;
  const whole = await fixtureFetch(source);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/quicktime");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(whole.headers.get("content-disposition"), "inline");
  assert.equal(whole.headers.get("x-content-type-options"), "nosniff");
  assert.match(whole.headers.get("content-security-policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), iphone);
  // Safari probes with bytes=0-1, then asks for the parts it plays.
  const probe = await fixtureFetch(source, { headers: { range: "bytes=0-1" } });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get("content-range"), `bytes 0-1/${iphone.length}`);
  assert.equal(probe.headers.get("content-length"), "2");
  assert.deepEqual(Buffer.from(await probe.arrayBuffer()), iphone.subarray(0, 2));
  const tail = await fixtureFetch(source, { headers: { range: "bytes=-100" } });
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), iphone.subarray(-100));
  const open = await fixtureFetch(source, { headers: { range: "bytes=19000-" } });
  assert.equal(open.status, 206);
  assert.deepEqual(Buffer.from(await open.arrayBuffer()), iphone.subarray(19000));
  const past = await fixtureFetch(source, {
    headers: { range: `bytes=${iphone.length}-` },
  });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("content-range"), `bytes */${iphone.length}`);
  // Several ranges get the whole file.
  const multi = await fixtureFetch(source, { headers: { range: "bytes=0-1,5-6" } });
  assert.equal(multi.status, 200);
  await multi.arrayBuffer();
});

test("video uploads refuse what is too large, no video or unknown", async (t) => {
  const { base, begin, put, workspace } = await videoChat(t);
  const huge = await begin("huge.mp4", 200 * 1024 * 1024 + 1, mp4File());
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).messageKey, "assistants.videoTooLarge");
  const photo = await begin("photo.mov", png.length, png);
  assert.equal(photo.status, 415);
  assert.equal((await photo.json()).messageKey, "assistants.attachmentUnsupported");
  assert.equal((await begin("clip.mp4", "x", mp4File())).status, 400);
  // A chunk above 8 MiB is refused and the upload given up.
  const size = 20 * 1024 * 1024;
  const started = await begin("clip.webm", size, webmFile());
  const { upload, received } = await started.json();
  const big = await put(upload, received, Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal(big.status, 413);
  assert.equal((await put(upload, 0, Buffer.alloc(1))).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(workspace, "attachments")), []);
  // The owner removes a video while it uploads.
  const again = await (await begin("clip.webm", size, webmFile())).json();
  const removed = await fixtureFetch(`${base}/${again.upload}`, {
    method: "DELETE",
    headers: { origin: base.split("/api")[0] },
  });
  assert.equal(removed.status, 204);
  assert.deepEqual(fs.readdirSync(path.join(workspace, "attachments")), []);
});
