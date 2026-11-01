import test from "node:test";
import assert from "node:assert/strict";
import {
  adapterImports,
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

// Composition roots construct the OpenClaw supervisor the port wraps (AGENTPIER-309).
const compositionRoot = (file) =>
  /^server\/application\/(?:[\w-]+-wiring|services|assistant-graph)\.js$/.test(file);
// Importers of an adapter module that have no port method to go through. This list
// may only shrink.
const adapterImportAllowlist = {
  // The MCP toolchains install the Node.js that OpenClaw's runtime manifest pins
  // (one reviewed pin for both; mcp-toolchains.yml watches the manifest).
  "server/features/mcp-packages/toolchain-manifest.js": [
    `${portDirectory}openclaw/runtime-manifest.js`,
  ],
  // The team plugin is provisioned for the shipped OpenClaw version and its rollback
  // targets; it moves into the adapter with team-plugin/ (ADR 0006, section 2).
  "server/features/assistants/team-plugin-install.js": [
    `${portDirectory}openclaw/runtime-manifest.js`,
  ],
};

test("runtime rule adapterImports: only the port's public modules are imported", () => {
  const found = Object.fromEntries(
    Object.entries(adapterImports(sources)).filter(([file]) => !compositionRoot(file)),
  );
  assert.deepEqual(found, adapterImportAllowlist, hint);
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
  const feature = (text) => [{ file: "server/features/assistants/x.js", text }];
  assert.deepEqual(
    adapterImports(
      feature(
        'import { a } from "./runtimes/openclaw/a.js";\n' +
          'export { b } from "./runtimes/openclaw/b.js";\n' +
          'await import("./runtimes/openclaw/c.js");\n' +
          'import "./runtimes/openclaw/d.js";\n' +
          'import { runtimeFor } from "./runtimes/runtime-for.js";\n' +
          'import { RUNTIME_PORTS } from "./runtimes/agent-runtime.js";\n' +
          'import { x } from "./runtime-paths.js";',
      ),
    ),
    {
      "server/features/assistants/x.js": ["a", "b", "c", "d"].map(
        (name) => `${portDirectory}openclaw/${name}.js`,
      ),
    },
  );
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
