import test from "node:test";
import assert from "node:assert/strict";
import {
  clientAccesses,
  gatewayMethods,
  portDirectory,
  serverSources,
} from "../helpers/runtime-port-scan.js";

// ADR 0006 (agent runtime port): server code outside server/features/assistants/runtimes/
// never names a Gateway method or reaches the runtime's client. Every caller moved
// behind the port (AGENTPIER-303 to 308), so the rule is absolute: no file may offend.
const sources = await serverSources();
const hint =
  "go through the agent runtime port (server/features/assistants/runtimes/runtime-for.js)";

test("runtime rule gatewayMethods: no server file outside the port names a Gateway method", () => {
  assert.deepEqual(gatewayMethods(sources), {}, hint);
});

test("runtime rule clientAccess: no server file outside the port reaches the runtime client", () => {
  assert.deepEqual(clientAccesses(sources), {}, hint);
});

test("the port directory itself is not scanned", () => {
  assert.ok(sources.length > 0);
  assert.equal(
    sources.some(({ file }) => file.startsWith(portDirectory)),
    false,
  );
});

test("OpenClaw's own modules live in the adapter", () => {
  // The exec allowlist policy reads OpenClaw's interpreter, wrapper and
  // package-manager lists (AGENTPIER-306).
  assert.equal(
    sources.some(({ file }) => file.endsWith("/exec-allowlist-policy.js")),
    false,
  );
});

test("the scanners recognise each kind of offender", () => {
  const scan = (text) => [{ file: "server/x.js", text }];
  assert.deepEqual(
    gatewayMethods(
      scan(
        'await client.call("sessions.list", {}); client.request(\n  "chat.history");' +
          'fn.call(this, "a.b"); client.call("sessions.list"); x.call("exec.approvals.get")',
      ),
    ),
    { "server/x.js": ["chat.history", "exec.approvals.get", "sessions.list"] },
  );
  assert.deepEqual(gatewayMethods(scan('client.call(method); call("x.y")')), {});
  assert.deepEqual(
    clientAccesses(
      scan(
        "runtime.client.call(); this.runtime?.client?.ready; " +
          "assistantRuntime.client; runtime.clientFactory; runtimeClient",
      ),
    ),
    { "server/x.js": 3 },
  );
});
