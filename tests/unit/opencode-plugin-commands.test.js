import test from "node:test";
import assert from "node:assert/strict";
import {
  openCodeCommands,
  openCodeCommandsSupported,
} from "../../server/features/requests/opencode-plugin.js";
import { openCodeTaskDriver } from "../../server/features/chat/opencode-task-driver.js";

/** A TUI showing `current`, whose sessions have the given parents. */
function fakeApi({ current = "ses_parent", parents = { ses_child: "ses_parent" } } = {}) {
  const calls = { get: [], abort: [] };
  const api = {
    route: {
      current: current ? { name: "session", params: { sessionID: current } } : null,
    },
    client: {
      session: {
        get: async (input, options) => {
          calls.get.push([input, options]);
          const parentID = parents[input.sessionID];
          return { data: { id: input.sessionID, ...(parentID ? { parentID } : {}) } };
        },
        abort: async (input, options) => {
          calls.abort.push([input, options]);
          return { data: true };
        },
      },
    },
  };
  return { api, calls };
}

test("session.abort aborts a child of the TUI's current session", async () => {
  const { api, calls } = fakeApi();
  await openCodeCommands(api)("session.abort", { sessionId: "ses_child" });
  assert.deepEqual(calls.get, [[{ sessionID: "ses_child" }, { throwOnError: true }]]);
  assert.deepEqual(calls.abort, [[{ sessionID: "ses_child" }, { throwOnError: true }]]);
});

test("session.abort refuses every session that is not a child of the current one", async () => {
  const cases = [
    [{}, { sessionId: "ses_foreign" }],
    [{ parents: { ses_child: "ses_other" } }, { sessionId: "ses_child" }],
    [{ current: null }, { sessionId: "ses_child" }],
    [{ parents: { ses_parent: "ses_parent" } }, { sessionId: "ses_parent" }],
    [{}, { sessionId: 42 }],
    [{}, {}],
    [{}, null],
  ];
  for (const [options, params] of cases) {
    const { api, calls } = fakeApi(options);
    await assert.rejects(openCodeCommands(api)("session.abort", params), {
      message: "not a child",
    });
    assert.deepEqual(calls.abort, [], JSON.stringify(params));
  }
});

test("session.abort refuses a malformed session id before the SDK sees it", async () => {
  const malformed = [
    "ses_../x",
    "ses_",
    "child",
    "ses_a b",
    `ses_${"a".repeat(200)}`,
    "ses_child\n",
  ];
  for (const sessionId of malformed) {
    const { api, calls } = fakeApi({ parents: { [sessionId]: "ses_parent" } });
    await assert.rejects(openCodeCommands(api)("session.abort", { sessionId }), {
      message: "not a child",
    });
    assert.deepEqual(calls, { get: [], abort: [] }, JSON.stringify(sessionId));
  }
});

test("a command the plugin does not know is refused without touching OpenCode", async () => {
  const { api, calls } = fakeApi();
  for (const name of ["session.delete", "abort", undefined, "__proto__"])
    await assert.rejects(openCodeCommands(api)(name, { sessionId: "ses_child" }), {
      message: "unknown command",
    });
  assert.deepEqual(calls, { get: [], abort: [] });
});

test("an abort that OpenCode rejects is refused with its message", async () => {
  const { api } = fakeApi();
  api.client.session.abort = async () => {
    throw Error("Session busy");
  };
  await assert.rejects(
    openCodeCommands(api)("session.abort", { sessionId: "ses_child" }),
    { message: "Session busy" },
  );
});

test("the plugin offers commands only when the SDK can read and abort sessions", () => {
  assert.equal(openCodeCommandsSupported(fakeApi().api), true);
  const { api } = fakeApi();
  delete api.client.session.abort;
  assert.equal(openCodeCommandsSupported(api), false);
  assert.equal(openCodeCommandsSupported({}), false);
});

test("the OpenCode driver stops agents only, through session.abort", async () => {
  const sent = [];
  const commands = {
    connected: (id) => id === "s",
    send: async (...args) => {
      sent.push(args);
      return { ok: true };
    },
  };
  const driver = openCodeTaskDriver({ commands });
  const session = { id: "s", tool: "opencode", status: "running" };
  assert.equal(driver.connected(session), true);
  assert.equal(driver.connected({ ...session, id: "t" }), false);
  assert.equal(driver.canStop(session, { kind: "agent", id: "ses_child" }), true);
  assert.equal(driver.canStop(session, { kind: "shell", id: "x" }), false);
  assert.deepEqual(await driver.stop(session, { kind: "agent", id: "ses_child" }), {
    ok: true,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "s");
  assert.deepEqual(sent[0][1], {
    name: "session.abort",
    params: { sessionId: "ses_child" },
  });
});
