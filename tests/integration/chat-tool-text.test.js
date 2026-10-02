import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, fixtureFetch as fetch } from "../helpers/application.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=";
const big = "abcdefghij".repeat(20000) + "END";

async function fixture(t) {
  const { root: dir, application: app, url } = await applicationFixture(t);
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const session = {
    id: "one",
    accountId: "local-claude",
    tool: "claude",
    cwd,
    status: "stopped",
  };
  const snapshot = {
    availability: "ready",
    providerSessionId: "native-one",
    tasks: [],
    messages: [
      { id: "big", role: "tool", text: big },
      {
        id: "img",
        role: "tool",
        text: "[image 1]",
        toolImages: [{ mime: "image/png", data: pngBase64 }],
        toolImagePath: "/tmp/dir/shot.png",
      },
    ],
  };
  app.sessions.get = async (id) => {
    if (id !== "one") throw Object.assign(new Error("Missing"), { status: 404 });
    return session;
  };
  app.chat.read = async () => structuredClone(snapshot);
  return { ...app, url, snapshot };
}

test("long tool text is truncated in payloads and served in full", async (t) => {
  const f = await fixture(t);
  const data = await f.chatImages.read("one");
  const row = data.messages[0];
  assert.equal(row.text.length, 12288);
  assert.equal(row.textTail.length, 4096);
  assert.equal(row.truncated.length, big.length);
  assert.equal(await f.chatImages.fullText("one", "big"), big);
  f.chatImages.toolTexts.forgetSession("one");
  assert.equal(await f.chatImages.fullText("one", "big"), big);
  await assert.rejects(f.chatImages.fullText("one", "unknown"), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.message, serverMessages.chat.toolTextUnavailable);
    return true;
  });
  const page = await f.chatImages.decoratePage("one", structuredClone(f.snapshot));
  assert.equal(page.messages[0].text.length, 12288);
});

test("tool images become references served on demand", async (t) => {
  const f = await fixture(t);
  const data = await f.chatImages.read("one");
  const row = data.messages[1];
  assert.equal(row.images.length, 1);
  assert.match(row.images[0].id, /^[a-f0-9]{64}$/);
  assert.equal(row.images[0].path, "shot.png · 1");
  assert.ok(!JSON.stringify(row).includes(pngBase64));
  assert.ok(!("toolImages" in row) && !("toolImagePath" in row));
  const expected = Buffer.from(pngBase64, "base64");
  let file = await f.chatImages.file("one", row.images[0].id);
  assert.equal(file.type, "image/png");
  assert.deepEqual(file.body, expected);
  f.chatImages.toolImages.forgetSession("one");
  file = await f.chatImages.file("one", row.images[0].id);
  assert.deepEqual(file.body, expected);
  await assert.rejects(f.chatImages.file("one", "0".repeat(64)), { status: 404 });
  const response = await fetch(
    `${f.url}/api/sessions/one/chat/images/${row.images[0].id}`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
});

test("full tool text is served over HTTP without caching", async (t) => {
  const f = await fixture(t);
  const ok = await fetch(`${f.url}/api/sessions/one/chat/messages/big/text`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control"), /no-store/);
  assert.equal((await ok.json()).text, big);
  const missing = await fetch(`${f.url}/api/sessions/one/chat/messages/nope/text`);
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).messageKey);
});

function pngOfSize(size) {
  const bytes = Buffer.alloc(size);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  return bytes;
}

test("a large tool image is cached and served from the store", async (t) => {
  const f = await fixture(t);
  const bytes = pngOfSize(3 * 1048576);
  f.snapshot.messages = [
    {
      id: "large",
      role: "tool",
      text: "[image 1]",
      toolImages: [{ mime: "image/png", data: bytes.toString("base64") }],
    },
  ];
  const data = await f.chatImages.read("one");
  const imageId = data.messages[0].images[0].id;
  assert.ok(f.chatImages.toolImages.lookup("one", imageId));
  f.snapshot.messages = [];
  const file = await f.chatImages.file("one", imageId);
  assert.equal(file.type, "image/png");
  assert.equal(file.body.length, bytes.length);
});

test("a tool image whose bytes are not a raster image is not served", async (t) => {
  const f = await fixture(t);
  f.snapshot.messages = [
    {
      id: "fake",
      role: "tool",
      text: "[image 1]",
      toolImages: [{ mime: "image/png", data: Buffer.from("<svg/>").toString("base64") }],
    },
  ];
  const data = await f.chatImages.read("one");
  const imageId = data.messages[0].images[0].id;
  await assert.rejects(f.chatImages.file("one", imageId), { status: 404 });
  f.chatImages.toolImages.forgetSession("one");
  await assert.rejects(f.chatImages.file("one", imageId), { status: 404 });
});

test("a stored tool image is served without re-deriving tool images", async (t) => {
  const f = await fixture(t);
  const data = await f.chatImages.read("one");
  const imageId = data.messages[1].images[0].id;
  let derived = 0;
  const original = f.chatImages.toolImageRefs.bind(f.chatImages);
  f.chatImages.toolImageRefs = (...args) => {
    derived += 1;
    return original(...args);
  };
  await f.chatImages.file("one", imageId);
  assert.equal(derived, 0);
  f.chatImages.toolImages.forgetSession("one");
  await f.chatImages.file("one", imageId);
  assert.equal(derived, 1);
});
