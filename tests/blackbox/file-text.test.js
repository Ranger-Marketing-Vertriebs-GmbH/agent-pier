import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture, fixtureFetch } from "../helpers/application.js";
import { uploadRequest } from "../helpers/file-uploads.js";

async function put(f, target, body, headers = {}) {
  const scope = await (await f.request("/api/files/context")).json();
  return fixtureFetch(`${f.url}/api/files/text?path=${encodeURIComponent(target)}`, {
    method: "PUT",
    headers: {
      origin: f.url,
      "content-type": "text/plain;charset=utf-8",
      "x-file-scope": scope.scopeId,
      "x-file-request": uploadRequest(),
      "if-none-match": "*",
      ...headers,
    },
    body,
  });
}
test("actual raw text route exceeds JSON cap while requiring explicit valid preconditions", async (t) => {
  const f = await applicationFixture(t),
    target = path.join(f.home, "raw");
  const response = await put(f, target, "x".repeat(70000));
  assert.equal(response.status, 200);
  const read = await f.request(`/api/files/text?path=${encodeURIComponent(target)}`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).text.length, 70000);
  const meta = await f.request(
    `/api/files/metadata?path=${encodeURIComponent(target)}&view=document`,
  );
  assert.deepEqual(Object.keys(await meta.json()).sort(), [
    "metadataRevision",
    "path",
    "resolvedPath",
  ]);
  for (const value of [
    "*",
    '"e1:' + "a".repeat(64) + '"',
    'W/"d1:' + "a".repeat(64) + '"',
  ]) {
    assert.equal((await put(f, target, "bad", { "if-match": value })).status, 400);
  }
  assert.equal(
    (await put(f, target + "large", Buffer.alloc(2 * 1024 ** 2 + 1, 97))).status,
    413,
  );
  assert.equal((await put(f, target + "bad", Buffer.from([0xc0, 0x80]))).status, 415);
  assert.equal(await fs.readFile(target, "utf8"), "x".repeat(70000));
});
