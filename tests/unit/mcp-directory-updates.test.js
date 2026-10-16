import test from "node:test";
import assert from "node:assert/strict";
import {
  directoryUpdate,
  directoryUpdates,
} from "../../server/features/mcp-directory/updates.js";

const packaged = (extra = {}) => ({
  id: "s1",
  transport: "stdio",
  source: { registry: "npm", name: "opnsense-mcp-server", version: "0.4.1" },
  directoryOrigin: { name: "io.github.example/opnsense-mcp-server", version: "0.4.1" },
  ...extra,
});
const entry = (options) => ({
  name: "io.github.example/opnsense-mcp-server",
  version: "0.5.0",
  options,
});
const npm = (identifier, version) => ({ kind: "npm", identifier, version });

test("a newer exact version of the same package is an update", () => {
  assert.deepEqual(
    directoryUpdate(packaged(), entry([npm("opnsense-mcp-server", "0.5.0")])),
    {
      serverId: "s1",
      version: "0.5.0",
    },
  );
  assert.equal(
    directoryUpdate(packaged(), entry([npm("opnsense-mcp-server", "0.4.1")])),
    null,
  );
  assert.equal(
    directoryUpdate(packaged(), entry([npm("opnsense-mcp-server", "0.4.0")])),
    null,
  );
  const pypi = packaged({
    source: { registry: "pypi", name: "mcp-server-fetch", version: "2025.4.7" },
  });
  assert.deepEqual(
    directoryUpdate(
      pypi,
      entry([{ kind: "pypi", identifier: "mcp_server_fetch", version: "2025.10.1" }]),
    ),
    { serverId: "s1", version: "2025.10.1" },
  );
});

test("a changed identifier or remote address is a hint only", () => {
  assert.deepEqual(
    directoryUpdate(packaged(), entry([npm("@example/opnsense", "1.0.0")])),
    {
      serverId: "s1",
      hint: "identifier",
    },
  );
  const remote = {
    id: "r1",
    transport: "http",
    url: "https://old.example.test/mcp",
    directoryOrigin: { name: "a.b/c", version: "1" },
  };
  assert.deepEqual(
    directoryUpdate(
      remote,
      entry([{ kind: "remote-http", url: "https://new.example.test/mcp" }]),
    ),
    { serverId: "r1", hint: "remote" },
  );
  assert.equal(
    directoryUpdate(
      remote,
      entry([{ kind: "remote-http", url: "https://old.example.test/mcp" }]),
    ),
    null,
  );
  assert.equal(
    directoryUpdate({ ...packaged(), directoryOrigin: undefined }, entry([])),
    null,
  );
});

test("at most 20 servers, 4 at a time; failures are skipped", async () => {
  let running = 0;
  let peak = 0;
  const servers = Array.from({ length: 25 }, (_, index) =>
    packaged({
      id: `s${index}`,
      directoryOrigin: { name: `a.b/s${index}`, version: "0.4.1" },
    }),
  );
  const asked = [];
  const updates = await directoryUpdates({
    servers,
    detail: async (name) => {
      asked.push(name);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (name === "a.b/s3") throw new Error("down");
      return entry([npm("opnsense-mcp-server", "0.5.0")]);
    },
  });
  assert.equal(asked.length, 20);
  assert.ok(peak <= 4);
  assert.equal(updates.length, 19);
});
