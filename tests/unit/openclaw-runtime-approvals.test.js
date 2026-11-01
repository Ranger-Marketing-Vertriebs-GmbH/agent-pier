import test from "node:test";
import assert from "node:assert/strict";
import { createOpenClawRuntime } from "../../server/features/assistants/runtimes/openclaw/openclaw-runtime.js";
import { GatewayClient } from "../../server/features/assistants/runtimes/openclaw/gateway-client.js";
import { allowAlwaysPlan } from "../../server/features/assistants/runtimes/openclaw/exec-allowlist-policy.js";

// A client that records each call as [method, params] and answers `answer`.
function recorder(answer = () => ({})) {
  const calls = [];
  return {
    calls,
    ready: true,
    async call(method, ...rest) {
      calls.push([method, ...rest]);
      return answer(method, rest[0]);
    },
  };
}
const stale = () =>
  Object.assign(new Error("stale"), {
    code: "INVALID_REQUEST",
    answered: true,
    remoteMessage:
      "exec approvals changed since last load; re-run exec.approvals.get and retry",
  });

test("the approvals sub-port sends the Gateway requests callers sent before the port", async () => {
  const client = recorder();
  const { approvals } = createOpenClawRuntime({ client });
  const file = { version: 1, agents: { "ap-1": { allowlist: [] } } };
  await approvals.list();
  await approvals.resolve({ id: "a1", decision: "allow-once" });
  await approvals.history();
  await approvals.readAllowlist();
  await approvals.writeAllowlist({ baseHash: "h1", file });
  assert.deepEqual(client.calls, [
    ["exec.approval.list", {}],
    ["exec.approval.resolve", { id: "a1", decision: "allow-once" }],
    ["approval.history", {}],
    ["exec.approvals.get", {}],
    ["exec.approvals.set", { baseHash: "h1", file }],
  ]);
});

test("staleAllowlist tells only OpenClaw's stale base hash refusal", () => {
  const { approvals } = createOpenClawRuntime({ client: null });
  assert.equal(approvals.staleAllowlist(stale()), true);
  const schema = Object.assign(new Error("x"), {
    code: "INVALID_REQUEST",
    remoteMessage: "invalid file",
  });
  assert.equal(approvals.staleAllowlist(schema), false);
  assert.equal(approvals.staleAllowlist(new Error("x")), false);
  assert.equal(approvals.staleAllowlist(undefined), false);
});

test("allowAlwaysPlan is OpenClaw's exec allowlist policy", () => {
  const { approvals } = createOpenClawRuntime({ client: null });
  const resolve = (name) => `/usr/bin/${name}`;
  for (const payload of [
    { command: "ls -la", cwd: "/work" },
    { command: "python3 -c 'print(1)'", cwd: "/work" },
    { command: "", cwd: "/work" },
  ])
    assert.deepEqual(
      approvals.allowAlwaysPlan(payload, { resolve, writable: () => false }),
      allowAlwaysPlan(payload, { resolve, writable: () => false }),
    );
  assert.deepEqual(
    approvals.allowAlwaysPlan(
      { command: "ls -la", cwd: "/work" },
      { resolve, writable: () => false },
    ),
    { kind: "paths", paths: ["/usr/bin/ls"], writable: [] },
  );
});

test("an approvals view reaches only the client it captured", async () => {
  // The client the supervisor replaced and closed (runtime-supervisor.js launch/stop).
  const old = new GatewayClient({
    url: "wss://127.0.0.1:1",
    token: "t",
    certPath: "/nonexistent",
  });
  const supervisor = { client: old };
  const runtime = createOpenClawRuntime(supervisor);
  const bound = runtime.approvals.on(runtime.host.connection());
  const fresh = recorder();
  supervisor.client = fresh;
  old.close();
  const closed = await old.call("exec.approval.list", {}).catch((e) => e);
  for (const pending of [
    bound.list(),
    bound.resolve({ id: "a1", decision: "deny" }),
    bound.history(),
    bound.readAllowlist(),
    bound.writeAllowlist({ baseHash: "h", file: {} }),
  ]) {
    const error = await pending.catch((e) => e);
    assert.deepEqual(
      [error.code, error.status, error.message],
      [closed.code, closed.status, closed.message],
    );
  }
  assert.deepEqual(fresh.calls, []);
  assert.equal(bound.staleAllowlist(stale()), true);
  assert.ok(Object.isFrozen(bound));
  assert.equal(bound.on, undefined);
  await runtime.approvals.on(runtime.host.connection()).list();
  assert.deepEqual(fresh.calls, [["exec.approval.list", {}]]);
});
