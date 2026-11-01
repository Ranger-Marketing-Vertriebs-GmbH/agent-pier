import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  clientAccesses,
  gatewayMethods,
  portDirectory,
  ratchet,
  serverSources,
} from "../helpers/runtime-port-scan.js";

// ADR 0006 (agent runtime port): server code outside server/features/assistants/runtimes/
// never names a Gateway method or reaches the runtime's client. Today's offenders are
// listed in tests/fixtures/runtime-port-allowlist.json. The list only shrinks: a new
// offender fails, and so does a fixed one until it leaves the list.
const allowlist = JSON.parse(
  await readFile(
    new URL("../fixtures/runtime-port-allowlist.json", import.meta.url),
    "utf8",
  ),
);
const sources = await serverSources();
const hint =
  "go through the agent runtime port (server/features/assistants/runtimes/runtime-for.js)";

test("the allowlist names exactly the enforced rules", () => {
  assert.deepEqual(Object.keys(allowlist).sort(), ["clientAccess", "gatewayMethods"]);
});

test("runtime rule gatewayMethods: no new offenders, fixed ones leave the allowlist", () => {
  assert.deepEqual(ratchet(gatewayMethods(sources), allowlist.gatewayMethods), [], hint);
});

test("runtime rule clientAccess: no new offenders, fixed ones leave the allowlist", () => {
  assert.deepEqual(ratchet(clientAccesses(sources), allowlist.clientAccess), [], hint);
});

test("the port directory itself is not scanned", () => {
  assert.ok(sources.length > 0);
  assert.equal(
    sources.some(({ file }) => file.startsWith(portDirectory)),
    false,
  );
});

test("the channels.status call moved into the port", () => {
  const file = "server/features/assistant-channels/telegram-senders.js";
  assert.equal(allowlist.gatewayMethods[file], undefined);
  assert.equal(gatewayMethods(sources)[file], undefined);
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

test("the ratchet reports new, grown and shrunk offenders", () => {
  assert.deepEqual(ratchet({ "a.js": 1 }, {}), ["a.js: 1 (allowed 0)"]);
  assert.deepEqual(ratchet({ "a.js": 3 }, { "a.js": 2 }), ["a.js: 3 (allowed 2)"]);
  assert.deepEqual(ratchet({ "a.js": 1 }, { "a.js": 2 }), [
    "a.js: 1 left, lower its allowance from 2 to 1",
  ]);
  assert.deepEqual(ratchet({}, { "a.js": 2 }), [
    "a.js: 0 left, lower its allowance from 2 by removing it",
  ]);
  assert.deepEqual(ratchet({ "a.js": ["x.y"] }, {}), ["a.js: x.y (not allowed)"]);
  assert.deepEqual(ratchet({ "a.js": ["x.y", "x.z"] }, { "a.js": ["x.y"] }), [
    "a.js: x.z (not allowed)",
  ]);
  assert.deepEqual(ratchet({ "a.js": ["x.y"] }, { "a.js": ["x.y", "x.z"] }), [
    "a.js: x.z no longer named, remove from allowlist",
  ]);
  assert.deepEqual(ratchet({}, { "a.js": ["x.y"] }), [
    "a.js: x.y no longer named, remove from allowlist",
  ]);
  assert.deepEqual(
    ratchet({ "a.js": ["x.y"], "b.js": 2 }, { "a.js": ["x.y"], "b.js": 2 }),
    [],
  );
});
