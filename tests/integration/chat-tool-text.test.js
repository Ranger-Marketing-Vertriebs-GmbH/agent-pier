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
  return { ...app, url, snapshot, cwd };
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
  assert.equal(row.images[0].source, "tool");
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

// Pages keyed by internal state; each page names the state of the next older
// page, like ChatStore.olderPages walking from a client cursor.
function stubOlderPages(f, pages, { providerSessionId = "native-one" } = {}) {
  const calls = [];
  f.chatImages.forgetSession("one");
  f.snapshot.history = { cursor: "c1", generation: 1 };
  f.chat.older = async () => assert.fail("the walk must not register client cursors");
  f.chat.olderPages = async function* (id, cursor, maxPages) {
    assert.equal(id, "one");
    assert.equal(maxPages, 20);
    let state = cursor;
    for (let index = 0; index < maxPages && state; index += 1) {
      calls.push(state);
      const page = pages[state];
      if (page instanceof Error) throw page;
      if (!page) throw Object.assign(new Error("expired"), { status: 409 });
      yield structuredClone({ providerSessionId, messages: page.messages });
      state = page.next ?? null;
    }
  };
  return calls;
}

test("tool text and images on older pages are served after store eviction", async (t) => {
  const f = await fixture(t);
  const olderText = "older-".repeat(5000) + "END";
  const olderRows = [
    { id: "old-big", role: "tool", text: olderText },
    {
      id: "old-img",
      role: "tool",
      text: "[image 1]",
      toolImages: [{ mime: "image/png", data: pngBase64 }],
    },
  ];
  const calls = stubOlderPages(f, {
    c1: { messages: [{ id: "u1", role: "user", text: "hi" }], next: "c2" },
    c2: { messages: [{ id: "u2", role: "user", text: "hello" }], next: "c3" },
    c3: { messages: olderRows, next: null },
  });
  const page = await f.chatImages.decoratePage("one", {
    providerSessionId: "native-one",
    messages: structuredClone(olderRows),
    history: { cursor: null, generation: 1 },
  });
  const imageId = page.messages[1].images[0].id;
  assert.equal(page.messages[0].truncated.length, olderText.length);
  f.chatImages.toolTexts.forgetSession("one");
  f.chatImages.toolImages.forgetSession("one");
  assert.equal(await f.chatImages.fullText("one", "old-big"), olderText);
  assert.deepEqual(calls, ["c1", "c2", "c3"]);
  const file = await f.chatImages.file("one", imageId);
  assert.equal(file.type, "image/png");
  assert.deepEqual(file.body, Buffer.from(pngBase64, "base64"));
  assert.equal(file.immutable, true);
  // Found rows are remembered, so a repeat lookup needs no further page walk.
  calls.length = 0;
  assert.equal(await f.chatImages.fullText("one", "old-big"), olderText);
  await f.chatImages.file("one", imageId);
  assert.deepEqual(calls, []);
  const response = await fetch(`${f.url}/api/sessions/one/chat/messages/old-big/text`);
  assert.equal((await response.json()).text, olderText);
});

test("the history walk stops at a null cursor, an error, or a provider change", async (t) => {
  const f = await fixture(t);
  let calls = stubOlderPages(f, {
    c1: { messages: [], next: "c2" },
    c2: { messages: [], next: null },
  });
  await assert.rejects(f.chatImages.fullText("one", "missing"), { status: 404 });
  await assert.rejects(f.chatImages.file("one", "1".repeat(64)), { status: 404 });
  assert.deepEqual(calls, ["c1", "c2", "c1", "c2"]);

  calls = stubOlderPages(f, { c1: { messages: [], next: "c2" }, c2: new Error("boom") });
  await assert.rejects(f.chatImages.fullText("one", "missing"), { status: 404 });
  await assert.rejects(f.chatImages.file("one", "1".repeat(64)), { status: 404 });
  assert.deepEqual(calls, ["c1", "c2", "c1", "c2"]);

  calls = stubOlderPages(
    f,
    { c1: { messages: [{ id: "x", role: "tool", text: "other" }], next: "c2" } },
    { providerSessionId: "native-two" },
  );
  await assert.rejects(f.chatImages.fullText("one", "x"), { status: 404 });
  assert.deepEqual(calls, ["c1"]);

  const endless = {};
  for (let index = 1; index <= 30; index += 1)
    endless[`c${index}`] = { messages: [], next: `c${index + 1}` };
  calls = stubOlderPages(f, endless);
  await assert.rejects(f.chatImages.fullText("one", "missing"), { status: 404 });
  assert.equal(calls.length, 20);
  const response = await fetch(`${f.url}/api/sessions/one/chat/images/${"1".repeat(64)}`);
  assert.equal(response.status, 404);
});

test("unknown ids are remembered briefly so repeated lookups walk once", async (t) => {
  const f = await fixture(t);
  const calls = stubOlderPages(f, {
    c1: { messages: [], next: "c2" },
    c2: { messages: [], next: null },
  });
  for (let round = 0; round < 2; round += 1) {
    await assert.rejects(f.chatImages.fullText("one", "missing"), { status: 404 });
    await assert.rejects(f.chatImages.file("one", "1".repeat(64)), { status: 404 });
  }
  assert.deepEqual(calls, ["c1", "c2", "c1", "c2"]);
  // Text and image misses are separate kinds even for the same id.
  await assert.rejects(f.chatImages.fullText("one", "1".repeat(64)), { status: 404 });
  assert.equal(calls.length, 6);
  // A provider session change or forgetting the session walks again.
  f.snapshot.providerSessionId = "native-two";
  await assert.rejects(f.chatImages.fullText("one", "missing"), { status: 404 });
  assert.equal(calls.length, 7);
  f.snapshot.providerSessionId = "native-one";
  f.chatImages.forgetSession("one");
  await assert.rejects(f.chatImages.fullText("one", "missing"), { status: 404 });
  assert.equal(calls.length, 9);
  // Misses expire after a minute.
  const now = Date.now;
  t.after(() => (Date.now = now));
  Date.now = () => now() + 61_000;
  await assert.rejects(f.chatImages.fullText("one", "missing"), { status: 404 });
  assert.equal(calls.length, 11);
});

test("tool images are cached immutably while path images stay uncached", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.cwd, "shot.png"), Buffer.from(pngBase64, "base64"));
  f.snapshot.messages.push({ id: "a1", role: "assistant", text: "See `shot.png`" });
  const data = await f.chatImages.read("one");
  const toolImage = data.messages[1].images[0];
  const pathImage = data.messages[2].images[0];
  assert.ok(pathImage?.url);
  const tool = await fetch(`${f.url}/api/sessions/one/chat/images/${toolImage.id}`);
  assert.equal(tool.status, 200);
  assert.equal(tool.headers.get("cache-control"), "private, max-age=31536000, immutable");
  const local = await fetch(`${f.url}${pathImage.url}`);
  assert.equal(local.status, 200);
  assert.equal(local.headers.get("cache-control"), "no-store");
});

const textRow = { id: "late", role: "tool", text: "late-".repeat(5000) };

test("inconclusive walks do not remember a miss", async (t) => {
  const f = await fixture(t);
  const pages = { c1: { messages: [], next: "c2" }, c2: new Error("expired") };
  const calls = stubOlderPages(f, pages);
  // No start cursor (stale or indexing snapshot) proves nothing.
  f.snapshot.history = { cursor: null, generation: 1 };
  await assert.rejects(f.chatImages.fullText("one", "late"), { status: 404 });
  assert.equal(f.chatImages.misses.size, 0);
  assert.deepEqual(calls, []);
  // A walk that fails partway proves nothing either.
  f.snapshot.history = { cursor: "c1", generation: 1 };
  await assert.rejects(f.chatImages.fullText("one", "late"), { status: 404 });
  assert.equal(f.chatImages.misses.size, 0);
  pages.c2 = { messages: [textRow], next: null };
  assert.equal(await f.chatImages.fullText("one", "late"), textRow.text);
});

test("a history generation change invalidates a remembered miss", async (t) => {
  const f = await fixture(t);
  const pages = { c1: { messages: [], next: null } };
  const calls = stubOlderPages(f, pages);
  await assert.rejects(f.chatImages.fullText("one", "late"), { status: 404 });
  assert.equal(f.chatImages.misses.size, 1);
  pages.c1 = { messages: [textRow], next: null };
  await assert.rejects(f.chatImages.fullText("one", "late"), { status: 404 });
  assert.equal(calls.length, 1);
  f.snapshot.history = { cursor: "c1", generation: 2 };
  assert.equal(await f.chatImages.fullText("one", "late"), textRow.text);
  assert.equal(calls.length, 2);
});

test("parallel lookups for one evicted row share a single walk", async (t) => {
  const f = await fixture(t);
  const row = {
    id: "many",
    role: "tool",
    text: Array.from({ length: 5 }, (_, index) => `[image ${index + 1}]`).join("\n"),
    toolImages: Array.from({ length: 5 }, () => ({ mime: "image/png", data: pngBase64 })),
  };
  const calls = stubOlderPages(f, {
    c1: { messages: [{ id: "u1", role: "user", text: "hi" }], next: "c2" },
    c2: { messages: [row], next: null },
  });
  const page = await f.chatImages.decoratePage("one", {
    providerSessionId: "native-one",
    messages: [structuredClone(row)],
    history: { cursor: null, generation: 1 },
  });
  const ids = page.messages[0].images.map((image) => image.id);
  assert.equal(new Set(ids).size, 5);
  f.chatImages.forgetSession("one");
  const files = await Promise.all(
    ids.map((imageId) => f.chatImages.file("one", imageId)),
  );
  assert.deepEqual(calls, ["c1", "c2"]);
  for (const file of files) assert.deepEqual(file.body, Buffer.from(pngBase64, "base64"));
  for (const imageId of ids) assert.ok(f.chatImages.toolImages.lookup("one", imageId));
  // Identical lookups for an unknown id also share one walk.
  calls.length = 0;
  await Promise.all(
    [1, 2, 3].map(() =>
      assert.rejects(f.chatImages.fullText("one", "missing"), { status: 404 }),
    ),
  );
  assert.deepEqual(calls, ["c1", "c2"]);
  assert.equal(f.chatImages.pendingWalks.size, 0);
  assert.equal(f.chatImages.walkQueues.size, 0);
});
