import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture, fixtureFetch } from "../helpers/application.js";

test("authenticated JSON of at least 1 KiB is gzip-compressed", async (t) => {
  const f = await applicationFixture(t);
  const response = await fixtureFetch(`${f.url}/api/state`, {
    headers: { "accept-encoding": "gzip" },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.length >= 1024, `state body too small: ${body.length}`);
  assert.equal(response.headers.get("content-encoding"), "gzip");
});

test("file downloads stay uncompressed", async (t) => {
  const f = await applicationFixture(t);
  const file = path.join(f.home, "large.txt");
  const bytes = Buffer.alloc(65536, 97);
  await fs.writeFile(file, bytes);
  const download = await fixtureFetch(
    `${f.url}/api/files/download?path=${encodeURIComponent(file)}`,
    { headers: { "accept-encoding": "gzip" } },
  );
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment/);
  assert.equal(download.headers.get("content-encoding"), null);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});

test("auth status is mounted before compression", async (t) => {
  const f = await applicationFixture(t);
  const response = await fetch(`${f.url}/auth/status`, {
    headers: { "accept-encoding": "gzip" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), null);
});
