import test from "node:test";
import assert from "node:assert/strict";
import { fileApi } from "../../web/features/files/file-api.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

test("typed saves freeze exact bytes and use scoped raw preconditions with durable response pairs", async (t) => {
  const d1 = `d1:${"a".repeat(64)}`,
    e1 = `e1:${"b".repeat(64)}`,
    calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({ path: "note", revision: d1, metadataRevision: e1 });
  });
  const api = fileApi({ kind: "project", sessionId: "session/one" }),
    bytes = new TextEncoder().encode("\uFEFFa\r\n");
  const original = bytes.slice(),
    signal = new AbortController().signal;
  const pending = api.saveText("note & one", bytes, {
    scopeId: "f1:scope",
    requestId: "request",
    revision: d1,
    signal,
  });
  bytes.fill(120);
  assert.deepEqual(await pending, { path: "note", revision: d1, metadataRevision: e1 });
  assert.deepEqual(calls[0].body, original);
  assert.match(
    calls[0].url,
    /^\/api\/sessions\/session%2Fone\/files\/explorer\/text\?path=note\+%26\+one$/,
  );
  assert.equal(calls[0].headers.get("if-match"), JSON.stringify(d1));
  assert.equal(calls[0].headers.get("if-none-match"), null);
  assert.equal(calls[0].headers.get("content-type"), "text/plain;charset=utf-8");
  assert.equal(calls[0].signal, signal);
  await api.saveText("note", original, {
    scopeId: "f1:scope",
    requestId: "request",
    revision: null,
  });
  assert.equal(calls[1].headers.get("if-none-match"), "*");
  assert.equal(calls[1].headers.get("if-match"), null);
  await api.documentMetadata("note", signal);
  assert.match(calls[2].url, /view=document$/);
});

test("text client rejects non-d1 results and keeps errors inert and reactive without changing draft bytes", async (t) => {
  const bytes = new TextEncoder().encode("private draft"),
    original = bytes.slice();
  let status = 200;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      status === 200
        ? {
            path: "x",
            revision: `p1:${"a".repeat(64)}`,
            metadataRevision: `e1:${"a".repeat(64)}`,
          }
        : {
            code: "FILE_CONFLICT_CHANGED",
            error: "private draft",
            text: "latest private bytes",
          },
      { status },
    ),
  );
  const client = fileApi({ kind: "global" }),
    options = { scopeId: "scope", requestId: "request", revision: null };
  await assert.rejects(client.saveText("/x", bytes, options), {
    code: "FILE_INVALID_RESPONSE",
  });
  status = 409;
  const error = await client.saveText("/x", bytes, options).catch((error) => error);
  assert.equal(error.code, "FILE_CONFLICT_CHANGED");
  assert.equal(JSON.stringify(error).includes("private"), false);
  setLanguage("en", { persist: false });
  const english = error.message;
  setLanguage("de", { persist: false });
  assert.notEqual(error.message, english);
  assert.deepEqual(bytes, original);
});

test("a malformed successful save body cannot become a typed revision result", async (t) => {
  let result;
  t.mock.method(globalThis, "fetch", async () => Response.json(result));
  const client = fileApi({ kind: "global" });
  for (const value of [
    null,
    {
      path: "/x",
      revision: [`d1:${"a".repeat(64)}`],
      metadataRevision: `e1:${"a".repeat(64)}`,
    },
    {
      path: "/x",
      revision: `d1:${"a".repeat(64)}`,
      metadataRevision: [`e1:${"a".repeat(64)}`],
    },
  ]) {
    result = value;
    await assert.rejects(
      client.saveText("/x", new Uint8Array(), {
        scopeId: "scope",
        requestId: "request",
        revision: null,
      }),
      { code: "FILE_INVALID_RESPONSE" },
    );
  }
});
