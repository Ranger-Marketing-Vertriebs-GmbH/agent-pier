import test from "node:test";
import assert from "node:assert/strict";
import { readExplorerRoute, explorerQuery } from "../../web/features/files/routes.js";
import { fileApi } from "../../web/features/files/file-api.js";
import { setLanguage } from "../../web/lib/i18n/index.js";
import { appDocumentPath } from "../../server/http/security.js";

test("global Explorer routes preserve encoded paths and compact defaults", () => {
  const route = readExplorerRoute(
    "?path=%2FUsers%2Fspace+folder%2F%C3%A4%23%25&file=%2Ftmp%2F%23%25.txt",
  );
  assert.deepEqual(route, {
    filePath: "/Users/space folder/ä#%",
    file: "/tmp/#%.txt",
    fileSort: "name",
    fileDirection: "asc",
    fileHidden: false,
    fileFilter: "",
    filePage: 1,
    filePageInvalid: null,
  });
  assert.equal(
    explorerQuery(route),
    "?path=%2FUsers%2Fspace+folder%2F%C3%A4%23%25&file=%2Ftmp%2F%23%25.txt",
  );
  assert.equal(explorerQuery(readExplorerRoute("")), "");
  assert.equal(appDocumentPath.test("/files"), true);
});

test("Explorer routes retain sort filter hidden and explicit invalid page state", () => {
  const route = readExplorerRoute(
    "?path=src&sort=modifiedAt&direction=desc&hidden=1&filter=a+b%23%25&page=07",
  );
  assert.deepEqual(route, {
    filePath: "src",
    file: "",
    fileSort: "modifiedAt",
    fileDirection: "desc",
    fileHidden: true,
    fileFilter: "a b#%",
    filePage: 1,
    filePageInvalid: "07",
  });
  assert.equal(
    explorerQuery(route),
    "?path=src&sort=modifiedAt&direction=desc&hidden=1&filter=a+b%23%25&page=07",
  );
  for (const value of ["", "0", "-1", "1.5", "Infinity", "9007199254740992"]) {
    const invalid = readExplorerRoute(`?page=${encodeURIComponent(value)}`);
    assert.equal(invalid.filePage, 1);
    assert.equal(invalid.filePageInvalid, value);
    assert.equal(explorerQuery(invalid), `?page=${encodeURIComponent(value)}`);
  }
  for (const value of ["other", "SIZE", "modified-at"])
    assert.equal(readExplorerRoute(`?sort=${value}`).fileSort, "name");
});

test("fileApi derives only scoped API bases and encodes GET query state", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => (globalThis.fetch = originalFetch));
  const signal = AbortSignal.abort();
  const global = fileApi({ kind: "global", root: "/untrusted" });
  const project = fileApi({
    kind: "project",
    sessionId: "space # % ü",
    root: "/untrusted",
  });
  assert.equal(global.base, "/api/files");
  assert.equal(project.base, "/api/sessions/space%20%23%20%25%20%C3%BC/files/explorer");
  assert.deepEqual(await global.get("/entries", { path: "/tmp/a #%.txt" }, signal), {
    ok: true,
  });
  assert.equal(calls[0][0], "/api/files/entries?path=%2Ftmp%2Fa+%23%25.txt");
  assert.equal(calls[0][1].signal, signal);
});

test("fileApi requires opened scope IDs for writes and cannot be header-overridden", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ saved: true }), { status: 200 });
  };
  t.after(() => (globalThis.fetch = originalFetch));
  const client = fileApi({ kind: "global" });
  await assert.rejects(client.mutate("/preferences", { body: {} }), /scopeId/);
  assert.equal(calls.length, 0);
  await client.mutate("/preferences", {
    method: "PATCH",
    body: { showHidden: true },
    scopeId: "f1:opened",
    headers: { "x-file-scope": "f1:forged", "x-extra": "present" },
  });
  const headers = calls[0][1].headers;
  assert.equal(headers.get("X-File-Scope"), "f1:opened");
  assert.equal(headers.get("X-Extra"), "present");
  assert.equal(headers.get("Content-Type"), "application/json");
});

test("fileApi raw requests encode queries, preserve abort and enforce write scope", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return new Response("bytes", { status: 200 });
  };
  t.after(() => (globalThis.fetch = originalFetch));
  const client = fileApi({ kind: "global" });
  const signal = AbortSignal.abort();
  const response = await client.raw("/download", {
    query: { path: "/tmp/a #%.txt" },
    signal,
  });
  assert.equal(await response.text(), "bytes");
  assert.equal(calls[0][0], "/api/files/download?path=%2Ftmp%2Fa+%23%25.txt");
  assert.equal(calls[0][1].signal, signal);
  await assert.rejects(
    client.raw("/uploads/id/content", { method: "PUT", body: "bytes" }),
    /scopeId/,
  );
  await client.raw("/uploads/id/content", {
    method: "PUT",
    body: "bytes",
    scopeId: "f1:opened",
    headers: { "X-FILE-SCOPE": "f1:forged" },
  });
  assert.equal(calls[1][1].headers.get("X-File-Scope"), "f1:opened");
});

test("fileApi errors retain stable fields and resolve message in the current language", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const events = [];
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: "/settings?path=<script>",
        code: "FILE_NOT_FOUND",
        args: { count: 2, unsafe: { path: "/private" } },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    setLanguage("de", { persist: false });
  });

  let issue;
  try {
    await fileApi({ kind: "global" }).get("/metadata", { path: "/private" });
  } catch (error) {
    issue = error;
  }
  assert.ok(issue instanceof Error);
  assert.equal(issue.status, 401);
  assert.equal(issue.code, "FILE_NOT_FOUND");
  assert.deepEqual(issue.args, { count: 2 });
  assert.deepEqual(events, ["agentpier-login-required"]);
  setLanguage("en", { persist: false });
  const english = issue.message;
  assert.equal(english.includes("not be found"), true);
  assert.equal(english.includes("settings"), false);
  setLanguage("de", { persist: false });
  assert.notEqual(issue.message, english);
});
