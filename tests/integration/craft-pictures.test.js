import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { craftRebuildsRoutes } from "../../server/http/routes/craft-rebuilds.js";
import { registerResponses } from "../../server/http/responses.js";
import {
  cleanPictureIds,
  RebuildPictures,
} from "../../server/features/craft/rebuild-pictures.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { rebuildsFixture, until } from "../helpers/craft-rebuilds-fixture.js";
import { avif, jpeg, png } from "../helpers/craft-pictures.js";

// Pictures of the original for Craft Anything rebuilds (craft/rebuild-pictures.js):
// staged by their bytes, handed to rebuild_start as absolute paths, gone afterwards.

const messages = serverMessages.craft;
const staged = (pictures) =>
  fs.existsSync(pictures.dir) ? fs.readdirSync(pictures.dir).sort() : [];

function pictures(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "craft-pictures-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return new RebuildPictures({ dataDir, ...options });
}

test("a picture is staged by its bytes as <id>.<ext>, owner-only", async (t) => {
  const p = pictures(t);
  const first = await p.stage(png());
  assert.match(first.id, /^[a-f0-9]{32}$/);
  assert.equal(first.type, "image/png");
  // The bytes decide, not a name: no name is ever taken from the caller.
  const second = await p.stage(jpeg());
  assert.equal(second.type, "image/jpeg");
  assert.deepEqual(staged(p), [`${first.id}.png`, `${second.id}.jpg`].sort());
  assert.equal(fs.statSync(p.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(p.dir, `${first.id}.png`)).mode & 0o777, 0o600);
  for (const body of [Buffer.from("not a picture"), avif(), Buffer.alloc(0), null])
    await assert.rejects(p.stage(body), {
      status: 400,
      message: messages.rebuildPictureType,
    });
  assert.equal(staged(p).length, 2);
});

test("size, waiting count and age are limited", async (t) => {
  let now = 0;
  const limits = { count: 10, maxBytes: 200, held: 2, ttlMs: 1000 };
  const p = pictures(t, { limits, now: () => now });
  await assert.rejects(p.stage(Buffer.concat([png(), Buffer.alloc(200)])), {
    status: 413,
    message: messages.rebuildPictureTooLarge,
  });
  const one = await p.stage(png());
  await p.stage(png());
  await assert.rejects(p.stage(png()), {
    status: 429,
    message: messages.rebuildPicturesBusy,
  });
  now = 1001;
  // The sweep made room: both waited too long.
  const fresh = await p.stage(png());
  assert.deepEqual(staged(p), [`${fresh.id}.png`]);
  assert.throws(() => p.take([one.id]), {
    status: 400,
    message: messages.rebuildPictureGone,
  });
});

test("take hands paths over once; release and discard remove the files", async (t) => {
  const p = pictures(t);
  const a = await p.stage(png());
  const b = await p.stage(jpeg());
  assert.throws(() => p.take([a.id, "f".repeat(32)]), { status: 400 });
  assert.equal(staged(p).length, 2, "nothing is taken when one is gone");
  const files = p.take([b.id, a.id]);
  assert.deepEqual(files, [
    path.join(p.dir, `${b.id}.jpg`),
    path.join(p.dir, `${a.id}.png`),
  ]);
  // A retry joining the start that took them releases nothing of them.
  p.release([a.id, b.id]);
  assert.equal(staged(p).length, 2);
  p.discard(files);
  assert.deepEqual(staged(p), []);
  const c = await p.stage(png());
  p.release([c.id, 42, null]);
  assert.deepEqual(staged(p), []);
});

test("only a short list of distinct ids is accepted", () => {
  const id = "a".repeat(32);
  assert.deepEqual(cleanPictureIds(undefined), []);
  assert.deepEqual(cleanPictureIds([id]), [id]);
  for (const value of [
    "x",
    [id, id],
    ["../etc/passwd"],
    ["/tmp/a.png"],
    [1],
    Array.from({ length: 11 }, (_v, i) => i.toString(16).padStart(32, "0")),
  ])
    assert.throws(() => cleanPictureIds(value), {
      status: 400,
      message: messages.rebuildPicturesInvalid,
    });
});

test("a server start removes what an earlier process staged", async (t) => {
  const f = rebuildsFixture(t);
  const left = await f.rebuilds.pictures.stage(png());
  assert.equal(staged(f.rebuilds.pictures).length, 1);
  const next = f.create();
  assert.deepEqual(staged(next.pictures), []);
  assert.throws(() => next.pictures.take([left.id]), { status: 400 });
});

test("a start from screenshots alone copies them into reference/ and drops the staged ones", async (t) => {
  const f = rebuildsFixture(t);
  const one = await f.rebuilds.pictures.stage(png());
  const two = await f.rebuilds.pictures.stage(jpeg());
  const files = [one, two].map((item, i) =>
    path.join(f.rebuilds.pictures.dir, `${item.id}.${["png", "jpg"][i]}`),
  );
  const view = await f.rebuilds.start({
    request: "A to-do app like these screenshots",
    target: "-",
    pictures: [one.id, two.id],
  });
  const record = f.craftRecord(view);
  assert.equal(record.target, "-");
  assert.deepEqual(record.pictures, files);
  assert.deepEqual(fs.readdirSync(path.join(view.folder, "reference")).sort(), [
    "picture-1.png",
    "picture-2.jpg",
  ]);
  assert.deepEqual(
    fs.readFileSync(path.join(view.folder, "reference", "picture-1.png")),
    png(),
  );
  assert.deepEqual(staged(f.rebuilds.pictures), []);
  // The record keeps no picture ids or paths.
  assert.ok(!JSON.stringify(f.rebuilds.get(view.id)).includes(one.id));
});

test("a refused or failed start leaves no staged picture and no rebuild", async (t) => {
  let fail = false;
  const f = rebuildsFixture(t, {
    intercept: (name) => {
      if (fail && name === "rebuild_start") throw new Error("Craft fell over");
    },
  });
  const gone = await f.rebuilds.pictures.stage(png());
  // An unknown id refuses before any folder exists; the known one goes too.
  await assert.rejects(
    f.rebuilds.start({ request: "X", pictures: [gone.id, "e".repeat(32)] }),
    { status: 400, message: messages.rebuildPictureGone },
  );
  await assert.rejects(f.rebuilds.start({ request: " ", pictures: [gone.id] }), {
    status: 400,
  });
  assert.deepEqual(staged(f.rebuilds.pictures), []);
  assert.deepEqual(fs.readdirSync(f.projectsDir), []);
  fail = true;
  const lost = await f.rebuilds.pictures.stage(png());
  await assert.rejects(f.rebuilds.start({ request: "Y", pictures: [lost.id] }), {
    status: 409,
  });
  assert.deepEqual(staged(f.rebuilds.pictures), []);
  assert.equal(f.rebuilds.list().length, 0);
});

test("a follow-up adds its pictures to the project's pictures of the original", async (t) => {
  const f = rebuildsFixture(t, { script: { steps: [{ finish: "ready" }] } });
  const view = await f.rebuilds.start({ request: "First", target: "https://a.test" });
  assert.ok(await until(() => f.rebuilds.get(view.id)?.status === "ready"));
  const picture = await f.rebuilds.pictures.stage(png());
  await assert.rejects(
    f.rebuilds.followUp(view.id, "Bigger", ["e".repeat(32), picture.id]),
    { status: 400 },
  );
  assert.deepEqual(staged(f.rebuilds.pictures), []);
  const next = await f.rebuilds.pictures.stage(png());
  await f.rebuilds.followUp(view.id, "Make it look like this", [next.id]);
  assert.deepEqual(fs.readdirSync(path.join(view.folder, "reference")), [
    "picture-1.png",
  ]);
  assert.ok(
    f.craftRecord(view).conversation.some((e) => e.text === "Make it look like this"),
  );
  assert.deepEqual(staged(f.rebuilds.pictures), []);
});

/** The rebuild routes over `services`, with raw bodies. */
async function app(t, services) {
  const application = express();
  application.use(express.json());
  application.use("/api", craftRebuildsRoutes(services));
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  return async (method, url, body, type = "application/json") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { "content-type": type },
      ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

test("POST /craft/pictures stages a raw picture for the next start", async (t) => {
  const f = rebuildsFixture(t);
  const request = await app(t, { craftRebuilds: f.rebuilds, craft: f.rebuilds.craft });
  const octet = "application/octet-stream";
  const uploaded = await request("POST", "/api/craft/pictures", png(), octet);
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.type, "image/png");
  assert.equal(uploaded.body.bytes, png().length);
  const text = await request("POST", "/api/craft/pictures", Buffer.from("hi"), octet);
  assert.equal(text.status, 400);
  assert.equal(text.body.messageKey, "craft.rebuildPictureType");
  const json = await request("POST", "/api/craft/pictures", { a: 1 });
  assert.equal(json.status, 415);
  const big = Buffer.alloc(20 * 1024 * 1024 + 2, 1);
  png().copy(big);
  const large = await request("POST", "/api/craft/pictures", big, octet);
  assert.equal(large.status, 413);
  assert.equal(large.body.messageKey, "craft.rebuildPictureTooLarge");
  const started = await request("POST", "/api/craft/rebuilds", {
    request: "From a screenshot",
    pictures: [uploaded.body.id],
  });
  assert.equal(started.status, 201);
  assert.deepEqual(fs.readdirSync(path.join(started.body.folder, "reference")), [
    "picture-1.png",
  ]);
  const unavailable = await app(t, {});
  assert.equal(
    (await unavailable("POST", "/api/craft/pictures", png(), octet)).status,
    503,
  );
});
