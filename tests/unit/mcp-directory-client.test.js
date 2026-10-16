import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { McpDirectory } from "../../server/features/mcp-directory/client.js";

const fixture = (name) =>
  JSON.parse(
    fs.readFileSync(
      new URL(`../fixtures/mcp-registry/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

function client({
  handler,
  settings = { enabled: true, baseUrl: "https://registry.test" },
  now = () => 0,
}) {
  const calls = [];
  const logs = [];
  const directory = new McpDirectory({
    settings: () => settings,
    now,
    log: (line) => logs.push(line),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(new URL(url), init);
    },
  });
  return { directory, calls, logs };
}

test("search asks the registry once per hour and normalises the answer", async () => {
  let now = 0;
  const { directory, calls } = client({
    now: () => now,
    handler: () =>
      json({ servers: [fixture("opnsense")], metadata: { nextCursor: "c1" } }),
  });
  const first = await directory.search({ search: "  OPNsense " });
  assert.equal(first.entries[0].name, "io.github.example/opnsense-mcp-server");
  assert.equal(first.nextCursor, "c1");
  await directory.search({ search: "opnsense" });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v0.1/servers");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    search: "opnsense",
    limit: "30",
    version: "latest",
  });
  assert.equal(calls[0].init.headers.accept, "application/json");
  assert.equal(calls[0].init.headers.authorization, undefined);
  now = 60 * 60 * 1000;
  await directory.search({ search: "opnsense" });
  assert.equal(calls.length, 2);
});

test("detail encodes the name as one segment; 404 and deleted are not found", async () => {
  const { directory, calls } = client({
    handler: (url) =>
      url.pathname.includes("gone")
        ? json({}, { status: 404 })
        : json(fixture("opnsense")),
  });
  const entry = await directory.detail("io.github.example/opnsense-mcp-server");
  assert.equal(entry.version, "0.4.1");
  assert.equal(
    new URL(calls[0].url).pathname,
    "/v0.1/servers/io.github.example%2Fopnsense-mcp-server/versions/latest",
  );
  await assert.rejects(
    directory.detail("io.github.example/gone"),
    (e) => e.code === "MCP_DIRECTORY_NOT_FOUND" && e.status === 404,
  );
  await assert.rejects(
    directory.detail("bad name"),
    (e) => e.code === "MCP_DIRECTORY_INVALID_REQUEST",
  );
});

test("429 and 5xx are cached for 60 s; other failures are not cached", async () => {
  let now = 0;
  let status = 429;
  const { directory, calls, logs } = client({
    now: () => now,
    handler: () => json({}, { status }),
  });
  await assert.rejects(
    directory.search({ search: "x" }),
    (e) => e.code === "MCP_DIRECTORY_UNAVAILABLE" && e.status === 503,
  );
  await assert.rejects(
    directory.search({ search: "x" }),
    (e) => e.code === "MCP_DIRECTORY_UNAVAILABLE",
  );
  assert.equal(calls.length, 1);
  now = 60 * 1000;
  status = 400;
  await assert.rejects(directory.search({ search: "x" }));
  await assert.rejects(directory.search({ search: "x" }));
  assert.equal(calls.length, 3);
  assert.ok(logs.length > 0);
  assert.ok(
    logs.every((line) => line.includes("registry.test") && !line.includes("search")),
  );
});

test("invalid JSON, oversize bodies and a foreign redirect are unavailable", async () => {
  for (const handler of [
    () => new Response("{not json", { status: 200 }),
    () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 }),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/v0.1/servers" },
      }),
  ]) {
    const { directory, calls } = client({ handler });
    await assert.rejects(
      directory.search({ search: "q" }),
      (e) => e.code === "MCP_DIRECTORY_UNAVAILABLE",
    );
    // The redirect target is never asked: the origin stays pinned to the registry.
    assert.deepEqual(
      calls.map((call) => new URL(call.url).host),
      ["registry.test"],
    );
  }
});

test("an invalid detail answers 502; a slow registry times out", async () => {
  const { directory } = client({ handler: () => json({ server: { name: 1 } }) });
  await assert.rejects(
    directory.detail("a.b/c"),
    (e) => e.code === "MCP_DIRECTORY_INVALID" && e.status === 502,
  );
  const slow = new McpDirectory({
    settings: () => ({ enabled: true, baseUrl: "https://registry.test" }),
    deadlineMs: 20,
    log: () => {},
    fetchImpl: (url, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason)),
      ),
  });
  await assert.rejects(
    slow.search({ search: "q" }),
    (e) => e.code === "MCP_DIRECTORY_UNAVAILABLE",
  );
});

test("disabled: no request, 409; status reports host and health", async () => {
  const settings = { enabled: false, baseUrl: "https://registry.test" };
  const { directory, calls } = client({
    settings,
    handler: () => json({ status: "ok" }),
  });
  await assert.rejects(
    directory.search({ search: "q" }),
    (e) => e.code === "MCP_DIRECTORY_DISABLED" && e.status === 409,
  );
  assert.deepEqual(await directory.status(), {
    enabled: false,
    host: "registry.test",
    reachable: false,
  });
  assert.equal(calls.length, 0);
  settings.enabled = true;
  assert.deepEqual(await directory.status(), {
    enabled: true,
    host: "registry.test",
    reachable: true,
  });
  await directory.status();
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/v0.1/health");
});

test("a bad cursor is refused; an unsafe next cursor is dropped", async () => {
  const { directory } = client({
    handler: () => json({ servers: [], metadata: { nextCursor: "a b" } }),
  });
  await assert.rejects(
    directory.search({ search: "q", cursor: "x".repeat(600) }),
    (e) => e.code === "MCP_DIRECTORY_INVALID_REQUEST",
  );
  assert.equal((await directory.search({ search: "q" })).nextCursor, null);
});

test("a loopback http registry is read directly, never through a redirect", async () => {
  const settings = { enabled: true, baseUrl: "http://127.0.0.1:9" };
  const ok = client({
    settings,
    handler: () => json({ servers: [fixture("opnsense")], metadata: {} }),
  });
  const answer = await ok.directory.search({ search: "q" });
  assert.equal(answer.entries.length, 1);
  assert.equal(ok.calls[0].init.redirect, "manual");
  assert.equal(ok.calls[0].init.headers.accept, "application/json");
  for (const handler of [
    () =>
      new Response(null, {
        status: 307,
        headers: { location: "http://127.0.0.1:9/v0.1/elsewhere" },
      }),
    () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 }),
    () => json({}, { status: 500 }),
  ]) {
    const { directory, calls } = client({ settings, handler });
    await assert.rejects(
      directory.search({ search: "q" }),
      (e) => e.code === "MCP_DIRECTORY_UNAVAILABLE",
    );
    assert.equal(calls.length, 1);
  }
  const missing = client({ settings, handler: () => json({}, { status: 404 }) });
  await assert.rejects(
    missing.directory.detail("a.b/c"),
    (e) => e.code === "MCP_DIRECTORY_NOT_FOUND",
  );
});

test("a same-origin redirect is followed; a deleted detail is not found", async () => {
  const { directory, calls } = client({
    handler: (url) =>
      url.pathname.endsWith("/latest")
        ? new Response(null, {
            status: 302,
            headers: { location: "/v0.1/servers/a.b%2Fc/versions/1.0.0" },
          })
        : json(fixture("deleted")),
  });
  await assert.rejects(
    directory.detail("a.b/c"),
    (e) => e.code === "MCP_DIRECTORY_NOT_FOUND" && e.status === 404,
  );
  assert.equal(calls.length, 2);
});

test("a 404 on the list is a misconfigured directory, a 404 on a detail is not found", async () => {
  const { directory } = client({ handler: () => json({}, { status: 404 }) });
  await assert.rejects(
    directory.search({ search: "q" }),
    (e) => e.code === "MCP_DIRECTORY_MISCONFIGURED" && e.status === 502,
  );
  await assert.rejects(
    directory.detail("a.b/c"),
    (e) => e.code === "MCP_DIRECTORY_NOT_FOUND" && e.status === 404,
  );
});
