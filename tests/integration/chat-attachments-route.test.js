import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, fixtureFetch as fetch } from "../helpers/application.js";
import { attachmentDirectory } from "../../server/features/chat/chat-attachments.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);

async function fixture(t, overrides = {}) {
  const { root: dir, application: app, url } = await applicationFixture(t);
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const session = {
    id: "one",
    accountId: "local-claude",
    tool: "claude",
    cwd,
    status: "running",
    attachments: {
      directory: attachmentDirectory(app.config.dataDir, "local-claude", "one"),
    },
    ...overrides,
  };
  app.sessions.get = async (id) => {
    if (id !== "one") throw Object.assign(new Error("Missing"), { status: 404 });
    return session;
  };
  return { url, session, dataDir: app.config.dataDir };
}

async function upload(f, body) {
  // authorizeRequest rejects any mutation without an Origin header, so every
  // POST here must carry one, same as every other route's tests do via f.request.
  return fetch(`${f.url}/api/sessions/one/chat/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: f.url },
    body: JSON.stringify(body),
  });
}

test("uploading an image returns its stored path and display name", async (t) => {
  const f = await fixture(t);
  const response = await upload(f, {
    name: "Bildschirmfoto.png",
    data: png.toString("base64"),
  });
  assert.equal(response.status, 201);
  const stored = await response.json();
  assert.equal(stored.name, "Bildschirmfoto.png");
  assert.equal(path.dirname(stored.path), f.session.attachments.directory);
  assert.deepEqual(fs.readFileSync(stored.path), png);
});

test("a payload above the global 64 kB parser is still accepted", async (t) => {
  const f = await fixture(t);
  // A 1x1 PNG passes even when the route-scoped parser is missing, so it cannot
  // prove the mount. rasterType only reads the header, so padding keeps this a
  // valid PNG while pushing the body past the global 64 kB limit.
  const padded = Buffer.concat([png, Buffer.alloc(1024 * 1024)]);
  const response = await upload(f, {
    name: "large.png",
    data: padded.toString("base64"),
  });
  assert.equal(response.status, 201);
  assert.equal(fs.statSync((await response.json()).path).size, padded.length);
});

test("a session started without a grant cannot receive attachments", async (t) => {
  const f = await fixture(t, { attachments: undefined });
  assert.equal(
    (await upload(f, { name: "a.png", data: png.toString("base64") })).status,
    409,
  );
});

test("a payload larger than the route body limit is refused rather than stored", async (t) => {
  const f = await fixture(t);
  const response = await upload(f, {
    name: "huge.png",
    data: Buffer.alloc(16 * 1024 * 1024).toString("base64"),
  });
  assert.equal(response.ok, false);
  assert.equal(fs.existsSync(f.session.attachments.directory), false);
});

test("raw documents and JSON images use the same granted session through HTTP", async (t) => {
  const f = await fixture(t);
  const response = await fetch(
    `${f.url}/api/sessions/one/chat/attachments?name=notes.txt`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Origin: f.url },
      body: "project notes",
    },
  );
  assert.equal(response.status, 201);
  const file = await response.json();
  assert.equal(path.dirname(path.dirname(file.path)), f.session.attachments.directory);
  assert.equal(fs.readFileSync(file.path, "utf8"), "project notes");
  const image = await upload(f, { name: "photo.png", data: png.toString("base64") });
  assert.equal(image.status, 201);
  assert.equal(path.dirname((await image.json()).path), f.session.attachments.directory);
});
