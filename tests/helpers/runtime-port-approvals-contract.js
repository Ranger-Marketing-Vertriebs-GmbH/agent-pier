import test from "node:test";
import assert from "node:assert/strict";

const unavailable = (error) => error.code === "UNAVAILABLE" && error.status === 503;
const agentId = "ap-1";
const pending = [
  { id: "a1", request: { command: "ls", agentId } },
  { id: "a2", request: { command: "rm x", agentId } },
];

/**
 * The approvals sub-port of the runtime port contract (runtime-port-contract.js):
 * pending requests, the owner's answer and how requests ended, the allowlist file
 * written over its hash, a view bound to a replaced connection, and all of it while
 * the runtime is unreachable. `make({ approvals })` starts with those requests
 * pending. `gaps` names capability gaps an adapter reports instead: "allowlist" (the
 * allowlist methods refuse with code UNSUPPORTED, as Hermes's until its config
 * sub-port owns the allowlist).
 */
export function approvalsContract(name, make, { gaps = [] } = {}) {
  const allowlist = !gaps.includes("allowlist");
  test(`${name}: approvals are listed, resolved and found in the history`, async () => {
    const { approvals } = await make({ approvals: pending });
    assert.deepEqual(
      (await approvals.list()).map((item) => item.id),
      ["a1", "a2"],
    );
    await approvals.resolve({ id: "a1", decision: "deny" });
    await approvals.resolve({ id: "a2", decision: "allow-once" });
    assert.deepEqual(await approvals.list(), []);
    const { items } = await approvals.history();
    const ended = Object.fromEntries(items.map((i) => [i.id, [i.status, i.decision]]));
    assert.deepEqual(ended.a1, ["denied", "deny"]);
    assert.deepEqual(ended.a2, ["allowed", "allow-once"]);
    // A request the runtime no longer holds is refused.
    await assert.rejects(
      approvals.resolve({ id: "a1", decision: "deny" }),
      (error) => error.answered === true,
    );
  });

  test(`${name}: the allowlist is written only over the hash it was read with`, async () => {
    const { approvals } = await make({});
    if (!allowlist) {
      const gap = (error) => error.code === "UNSUPPORTED" && !!error.unsupported;
      await assert.rejects(approvals.readAllowlist(), gap);
      await assert.rejects(approvals.writeAllowlist({ baseHash: "h", file: {} }), gap);
      assert.equal(approvals.staleAllowlist(new Error("other")), false);
      return;
    }
    const before = await approvals.readAllowlist();
    assert.equal(typeof before.hash, "string");
    const file = {
      version: 1,
      ...before.file,
      agents: { [agentId]: { allowlist: [{ id: "e1", pattern: "/bin/ls" }] } },
    };
    await approvals.writeAllowlist({ baseHash: before.hash, file });
    const after = await approvals.readAllowlist();
    assert.notEqual(after.hash, before.hash);
    assert.deepEqual(after.file.agents[agentId].allowlist, [
      { id: "e1", pattern: "/bin/ls" },
    ]);
    const stale = await approvals
      .writeAllowlist({ baseHash: before.hash, file: { version: 1 } })
      .then(
        () => assert.fail("a stale hash is refused"),
        (error) => error,
      );
    assert.equal(approvals.staleAllowlist(stale), true);
    assert.equal(approvals.staleAllowlist(new Error("other")), false);
    assert.equal((await approvals.readAllowlist()).hash, after.hash);
  });

  test(`${name}: allowAlwaysPlan answers a withheld allow-always synchronously`, async () => {
    const { approvals } = await make({});
    for (const payload of [{ command: "" }, { command: "python3 -c 'print(1)'" }]) {
      const plan = approvals.allowAlwaysPlan(payload, { pathDirs: [] });
      assert.equal(plan.kind, "once", payload.command);
      assert.equal(typeof plan.reason, "string");
    }
  });

  test(`${name}: an approvals view bound to a replaced connection reaches nothing`, async () => {
    const runtime = await make({ approvals: pending });
    const bound = runtime.approvals.on(runtime.host.connection());
    assert.equal((await bound.list()).length, 2);
    await runtime.host.restart();
    const before = allowlist ? await runtime.approvals.readAllowlist() : { hash: "h" };
    await assert.rejects(bound.list(), unavailable);
    await assert.rejects(bound.resolve({ id: "a1", decision: "deny" }), unavailable);
    await assert.rejects(bound.history(), unavailable);
    await assert.rejects(
      bound.writeAllowlist({ baseHash: before.hash, file: { version: 1 } }),
      unavailable,
    );
    // The new connection received none of it.
    if (allowlist)
      assert.equal((await runtime.approvals.readAllowlist()).hash, before.hash);
    else assert.deepEqual((await runtime.approvals.history()).items, []);
    assert.equal(bound.staleAllowlist(new Error("x")), false);
  });

  test(`${name}: approvals reject while unreachable`, async () => {
    const { approvals } = await make({ unreachable: true });
    const calls = {
      list: () => approvals.list(),
      resolve: () => approvals.resolve({ id: "a1", decision: "deny" }),
      history: () => approvals.history(),
      readAllowlist: () => approvals.readAllowlist(),
      writeAllowlist: () => approvals.writeAllowlist({ baseHash: "h", file: {} }),
    };
    for (const [method, call] of Object.entries(calls)) {
      // A rejection, never a synchronous throw: callers await it inside try/catch.
      const pending = call();
      assert.ok(pending instanceof Promise, method);
      await assert.rejects(pending, method);
    }
    assert.equal(approvals.allowAlwaysPlan({ command: "" }).kind, "once");
  });
}

/**
 * Exec approvals and an allowlist file held in memory for the fake runtime, kept
 * across restarts. Every async call goes through `reach`, which rejects while the
 * runtime is unreachable; `approvals` are the requests pending at the start.
 */
export function fakeApprovalPorts({ reach, connection, approvals: initial = [] }) {
  const waiting = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const ended = [];
  let file = { version: 1 };
  let writes = 0;
  const answered = (code, remoteMessage = code) =>
    Object.assign(new Error(code), { code, answered: true, remoteMessage });
  const statuses = { deny: "denied", "allow-once": "allowed", "allow-always": "allowed" };
  const methods = {
    list: () => reach(() => [...waiting.values()].map((item) => structuredClone(item))),
    resolve: ({ id, decision }) =>
      reach(() => {
        if (!waiting.delete(id)) throw answered("INVALID_REQUEST");
        ended.push({ id, status: statuses[decision], decision });
        return { ok: true };
      }),
    history: () => reach(() => ({ items: ended.map((item) => ({ ...item })) })),
    readAllowlist: () =>
      reach(() => ({ file: structuredClone(file), hash: `fake-${writes}` })),
    writeAllowlist: ({ baseHash, file: next }) =>
      reach(() => {
        if (baseHash !== `fake-${writes}`)
          throw answered("INVALID_REQUEST", "changed since last load");
        file = structuredClone(next);
        writes++;
        return { ok: true };
      }),
    staleAllowlist: (error) =>
      error?.code === "INVALID_REQUEST" &&
      /changed since last load/.test(error.remoteMessage),
    // The fake pins no program: every withheld allow-always is allowed once.
    allowAlwaysPlan: (payload) =>
      payload?.command
        ? { kind: "once", reason: "interpreter" }
        : { kind: "once", reason: "unresolved" },
  };
  const sync = ["staleAllowlist", "allowAlwaysPlan"];
  const closed = () =>
    Promise.reject(
      Object.assign(new Error("closed"), { code: "UNAVAILABLE", status: 503 }),
    );
  const on = (bound) =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(methods).map(([name, method]) => [
          name,
          sync.includes(name)
            ? method
            : (...args) => (bound && bound === connection() ? method(...args) : closed()),
        ]),
      ),
    );
  return { approvals: { ...methods, on } };
}
