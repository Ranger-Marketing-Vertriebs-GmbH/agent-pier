import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpCommandRoutes } from "../../server/http/routes/mcp-commands.js";
import { registerResponses } from "../../server/http/responses.js";

async function app(t, executables) {
  const application = express();
  application.use(
    "/api",
    mcpCommandRoutes({
      mcpServers: {
        resolveOptions: { pathEnv: "/fake/bin", exists: (file) => executables.has(file) },
      },
    }),
  );
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  return async (name) => {
    const query = name === undefined ? "" : `?name=${encodeURIComponent(name)}`;
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/mcp-commands/resolve${query}`,
    );
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      body: await response.json(),
    };
  };
}

test("a bare name resolves on the service PATH; nothing is executed", async (t) => {
  const resolve = await app(t, new Set(["/fake/bin/uvx"]));
  assert.deepEqual(await resolve("uvx"), {
    status: 200,
    cache: "no-store",
    body: { found: true, path: "/fake/bin/uvx" },
  });
});

test("unknown, relative, empty, overlong and control-character names are not found", async (t) => {
  const resolve = await app(t, new Set(["/fake/bin/uvx"]));
  for (const name of [
    "nope",
    "./uvx",
    "bin/uvx",
    "",
    " ",
    "a".repeat(5000),
    "uv\nx",
    undefined,
  ])
    assert.deepEqual((await resolve(name)).body, { found: false }, String(name));
});

test("an absolute path must be an executable file", async (t) => {
  const resolve = await app(t, new Set(["/opt/tool"]));
  assert.deepEqual((await resolve("/opt/tool")).body, { found: true, path: "/opt/tool" });
  assert.deepEqual((await resolve("/opt/other")).body, { found: false });
});
