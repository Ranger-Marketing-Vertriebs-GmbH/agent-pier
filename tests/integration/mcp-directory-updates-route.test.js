import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mcpDirectoryRoutes } from "../../server/http/routes/mcp-directory.js";
import { registerResponses } from "../../server/http/responses.js";

async function app(t, { enabled = true, servers = [], detail }) {
  const calls = [];
  const services = {
    mcpServers: { list: () => servers },
    mcpDirectory: {
      current: () => ({ enabled }),
      detail: async (name) => {
        calls.push(name);
        return detail(name);
      },
    },
  };
  const application = express();
  application.use("/api", mcpDirectoryRoutes(services));
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  const get = async () =>
    (
      await fetch(`http://127.0.0.1:${server.address().port}/api/mcp-directory/updates`)
    ).json();
  return { get, calls };
}

const origin = { name: "a.b/c", version: "1.0.0" };

test("updates are asked only for servers from the directory", async (t) => {
  const { get, calls } = await app(t, {
    servers: [
      {
        id: "s1",
        transport: "stdio",
        source: { registry: "npm", name: "c", version: "1.0.0" },
        directoryOrigin: origin,
      },
      { id: "s2", transport: "http", url: "https://x.test/mcp" },
    ],
    detail: async () => ({
      options: [{ kind: "npm", identifier: "c", version: "1.1.0" }],
    }),
  });
  assert.deepEqual(await get(), { updates: [{ serverId: "s1", version: "1.1.0" }] });
  assert.deepEqual(calls, ["a.b/c"]);
});

test("a turned-off directory answers no updates and asks nothing", async (t) => {
  const { get, calls } = await app(t, {
    enabled: false,
    servers: [{ id: "s1", directoryOrigin: origin }],
    detail: async () => ({ options: [] }),
  });
  assert.deepEqual(await get(), { updates: [] });
  assert.deepEqual(calls, []);
});
