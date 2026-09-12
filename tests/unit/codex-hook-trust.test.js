import test from "node:test";
import assert from "node:assert/strict";
import {
  hookTrustScreen,
  observeHookTrust,
  answerHookTrust,
} from "../../server/features/requests/codex-hook-trust.js";
import { hookScreen, hookList } from "../fixtures/requests/codex-hook-trust.js";

test("startup trust recognition rejects prose, incomplete menus and noncurrent frames", () => {
  for (const selected of [1, 2, 3])
    assert.deepEqual(hookTrustScreen(hookScreen(selected)), {
      count: 2,
      selected,
      error: false,
    });
  assert.ok(
    hookTrustScreen(
      hookScreen().replace(
        "Hooks can run outside the sandbox after you trust them.",
        "Hooks can run outside the sandbox after you tr",
      ),
    ),
  );
  assert.equal(hookTrustScreen("Assistant said:\n" + hookScreen()), null);
  assert.equal(hookTrustScreen(hookScreen() + "\n› User input"), null);
  assert.equal(
    hookTrustScreen(hookScreen().replace("Trust all and continue", "Other choice")),
    null,
  );
  assert.equal(hookTrustScreen(hookScreen().replace("›", " ")), null);
  assert.equal(
    hookTrustScreen(hookScreen(2, "Failed to trust hooks: fixture")).error,
    true,
  );
});
test("real startup hooks RPC supplies details and native hash-matched write acknowledges trust", () => {
  const asks = [],
    resolved = [];
  const channel = {
    launch: { cwd: "/fixture" },
    publish: (...args) => asks.push(args),
    resolve: (...args) => resolved.push(args),
  };
  const observer = observeHookTrust(channel);
  observer.incoming({ id: "unknown", result: hookList });
  assert.equal(asks.length, 0);
  observer.outgoing({ id: "list", method: "hooks/list", params: { cwds: ["/fixture"] } });
  observer.incoming({ id: "list", result: hookList });
  assert.equal(asks.length, 1);
  assert.equal(asks[0][1].presentation, "codexHookTrust");
  assert.equal(asks[0][1].hookCount, 2);
  observer.outgoing({
    id: "wrong",
    method: "config/batchWrite",
    params: {
      edits: [{ keyPath: "hooks.state", value: { one: { trusted_hash: "wrong" } } }],
    },
  });
  observer.incoming({ id: "wrong", result: {} });
  assert.equal(resolved.length, 0);
  const write = {
    id: "write",
    method: "config/batchWrite",
    params: {
      edits: [
        {
          keyPath: "hooks.state",
          value: { one: { trusted_hash: "hash-one" }, two: { trusted_hash: "hash-two" } },
        },
      ],
    },
  };
  observer.outgoing(write);
  observer.incoming({ id: "write", error: { message: "failure" } });
  assert.equal(resolved.length, 0);
  observer.outgoing({ ...write, id: "ok" });
  observer.incoming({ id: "ok", result: {} });
  assert.deepEqual(resolved[0], [asks[0][0], "trusted"]);
  observer.outgoing({ method: "thread/start" });
  observer.outgoing({ id: "late", method: "hooks/list", params: { cwds: ["/fixture"] } });
  observer.incoming({ id: "late", result: hookList });
  assert.equal(asks.length, 1);
});
function controlFixture() {
  let selected = 1,
    raw = null;
  const keys = [];
  const entry = {
    id: "request",
    sessionId: "one",
    accountId: "account",
    hookCount: 2,
    launchIdentity: "launch",
  };
  const broker = {
    entries: new Map([[entry.id, entry]]),
    launchIdentity: async () => "launch",
    sessions: {
      control: async (id, operation) =>
        operation({
          session: {
            accountId: "account",
            tool: "codex",
            nativeRequests: { enabled: true },
          },
          screen: async () => raw ?? hookScreen(selected),
          keys: async (values) => {
            keys.push(...values);
            for (const key of values) {
              if (key === "Down") selected++;
              if (key === "Up") selected--;
              if (key === "Enter") {
                raw = "› Composer";
                entry.nativeOutcome = "trusted";
              }
            }
          },
        }),
    },
  };
  return { broker, entry, keys, setRaw: (value) => (raw = value) };
}
test("startup answer selects the exact native option and submits once", async () => {
  for (const choice of ["trust", "skip"]) {
    const f = controlFixture();
    await answerHookTrust(f.broker, f.entry, choice);
    assert.deepEqual(
      f.keys,
      choice === "trust" ? ["Down", "Enter"] : ["Down", "Down", "Enter"],
    );
  }
});
test("replaced launches and changed screens refuse approval without Enter", async () => {
  const f = controlFixture();
  f.broker.launchIdentity = async () => "replacement";
  await assert.rejects(answerHookTrust(f.broker, f.entry, "trust"), { status: 409 });
  assert.ok(!f.keys.includes("Enter"));
  const g = controlFixture();
  g.setRaw("› Normal composer");
  await assert.rejects(answerHookTrust(g.broker, g.entry, "trust"), { status: 409 });
  assert.deepEqual(g.keys, []);
});
