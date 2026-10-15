import test from "node:test";
import assert from "node:assert/strict";
import { createShutdown } from "../../server/application/shutdown.js";

/** Only the services shutdown always closes; every optional one is left out. */
function services(calls, extra = {}) {
  const closing = (name) => ({ close: async () => calls.push(name) });
  return {
    agentbus: closing("agentbus"),
    installer: closing("installer"),
    plugins: closing("plugins"),
    repositories: closing("repositories"),
    extensions: closing("extensions"),
    history: closing("history"),
    sessions: closing("sessions"),
    memoryIntegration: closing("memoryIntegration"),
    memory: { close: () => calls.push("memory") },
    audit: { close: () => calls.push("audit") },
    ...extra,
  };
}

test("shutdown stops running MCP package installs before the server store closes", async () => {
  const calls = [];
  const close = createShutdown({
    services: services(calls, {
      mcpPackages: { close: async () => calls.push("mcpPackages") },
      mcpServers: { close: () => calls.push("mcpServers") },
    }),
    wss: null,
    server: { listening: false },
  });
  await close();
  assert.ok(calls.includes("mcpPackages"));
  assert.ok(calls.indexOf("mcpPackages") < calls.indexOf("mcpServers"));
});
