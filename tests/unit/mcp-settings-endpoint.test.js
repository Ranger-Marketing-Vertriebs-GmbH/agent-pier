import test from "node:test";
import assert from "node:assert/strict";
import { mcpEndpoint } from "../../web/features/mcp/setup.js";
test("setup accepts fixed-port loopback HTTP without changing a remote HTTPS URL", () => {
  for (const value of [
    "http://127.0.0.1:4000/mcp",
    "http://localhost:4389/mcp",
    "http://[::1]:4389/mcp",
    "http://localhost:80/mcp",
    "https://agentpier.example.test:8443/mcp",
  ])
    assert.equal(mcpEndpoint(value), value);
});
test("setup rejects non-loopback HTTP, missing ports and unsafe URL additions", () => {
  for (const value of [
    "http://agentpier.example.test:4000/mcp",
    "http://192.168.1.20:4000/mcp",
    "http://100.64.0.1:4000/mcp",
    "http://127.0.0.1/mcp",
    "http://localhost/mcp",
    "http://[::1]/mcp",
    "http://localhost:0/mcp",
    "http://localhost:65536/mcp",
    "http://127.1:4000/mcp",
    "http://127.0.0.1.evil.test:4000/mcp",
    "http://user@localhost:4000/mcp",
    "https://user:secret@example.test/mcp",
    "http://localhost:4000/mcp?token=secret",
    "http://localhost:4000/mcp#token",
    "file:///mcp",
  ])
    assert.equal(mcpEndpoint(value), null, value);
});
