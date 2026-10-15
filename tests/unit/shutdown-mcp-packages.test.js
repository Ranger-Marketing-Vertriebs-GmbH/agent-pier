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

test("shutdown starts stopping MCP package installs first and awaits it before the store closes", async () => {
  const calls = [];
  const close = createShutdown({
    services: services(calls, {
      mcpPackages: {
        close: () => {
          calls.push("mcpPackages:start");
          return new Promise((resolve) =>
            setTimeout(() => resolve(calls.push("mcpPackages:done")), 50),
          );
        },
      },
      mcpServers: { close: () => calls.push("mcpServers") },
    }),
    wss: null,
    server: { listening: false },
  });
  await close();
  assert.equal(calls[0], "mcpPackages:start");
  assert.ok(calls.indexOf("mcpPackages:done") < calls.indexOf("mcpServers"));
});
