import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { folderScreenWithWarnings } from "../fixtures/requests/claude-folder-trust.js";
import {
  autoModeBillingScreen,
  autoModeDefaultScreen,
  autoModeLookalikeScreen,
  unknownMenuScreen,
} from "../fixtures/requests/claude-startup-prompts.js";

/** A fake Claude terminal whose screen is a function of `state`; keys move it on. */
async function fixture(t, { started = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-auto-mode-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const session = {
    id: "auto",
    tool: "claude",
    accountId: "one",
    status: "running",
    cwd,
    nativeRequests: { enabled: true },
    nativeBinding: { enabled: true },
  };
  const keys = [];
  const state = { screen: "default", selected: "accept", controls: 0 };
  const render = {
    default: () => autoModeDefaultScreen(state.selected),
    billing: () => autoModeBillingScreen({ boxed: true }),
    lookalike: () => autoModeLookalikeScreen(),
    trust: () => folderScreenWithWarnings(cwd, state.selected),
    unknown: () => unknownMenuScreen(),
    composer: () => autoModeLookalikeScreen(),
  };
  let lock = Promise.resolve();
  const serial = (operation) => {
    const run = lock.then(operation);
    lock = run.catch(() => {});
    return run;
  };
  const broker = new RequestBroker({
    dataDir: root,
    sessions: {
      get: async () => session,
      control: (_id, operation) =>
        serial(() => {
          state.controls++;
          return operation({
            session,
            screen: async () => render[state.screen](),
            keys: async (values) => {
              keys.push(...values);
              for (const key of values) {
                if (key === "Down") state.selected = "decline";
                if (key === "Up") state.selected = "accept";
                if (["Enter", "Escape"].includes(key)) state.screen = "composer";
              }
            },
          });
        }),
    },
  });
  await broker.prepare({
    id: session.id,
    account: { id: "one", tool: "claude" },
    cwd,
    launch: {
      command: "/fixture/claude",
      args: [],
      env: { CLAUDE_CONFIG_DIR: path.join(root, "profile") },
    },
  });
  const bindingDir = path.join(root, "native-sessions");
  await fs.mkdir(bindingDir);
  const binding = {
    id: session.id,
    accountId: session.accountId,
    tool: "claude",
    cwd,
    token: "binding",
  };
  await fs.writeFile(path.join(bindingDir, "auto.launch.json"), JSON.stringify(binding));
  if (started)
    await fs.writeFile(
      path.join(bindingDir, "auto.receipt.json"),
      JSON.stringify(binding),
    );
  t.after(async () => {
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { broker, session, keys, state };
}
const answer = (f, ask, choice) =>
  f.broker.answer("auto", ask.id, { expectedRevision: ask.revision, choice });

test("the auto mode default prompt after the receipt is answered from chat", async (t) => {
  const f = await fixture(t);
  const ask = (await f.broker.list("auto")).requests[0];
  assert.equal(ask.presentation, "claudeStartupPrompt");
  assert.equal(ask.subject.dialog, "autoModeDefault");
  assert.deepEqual(
    ask.options.map((o) => [o.id, o.label]),
    [
      ["accept", "Yes, set auto mode as my default permission mode"],
      ["decline", "No, keep manual mode"],
    ],
  );
  assert.equal(f.broker.hasPending("auto"), true);
  assert.deepEqual((await answer(f, ask, "decline")).requests, []);
  assert.deepEqual(f.keys, ["Down", "Enter"]);
});
test("the billing notice sends Enter to continue and Escape to cancel", async (t) => {
  for (const [choice, key] of [
    ["continue", "Enter"],
    ["cancel", "Escape"],
  ]) {
    const f = await fixture(t);
    f.state.screen = "billing";
    const ask = (await f.broker.list("auto")).requests[0];
    assert.equal(ask.subject.dialog, "autoModeBilling");
    const events = [];
    f.broker.onEvent = (event) => events.push(event.details?.decision);
    assert.deepEqual((await answer(f, ask, choice)).requests, []);
    assert.deepEqual(f.keys, [key]);
    assert.deepEqual(events.filter(Boolean), [choice === "cancel" ? "deny" : "allow"]);
  }
});
test("a running session never turns transcript text or onboarding into requests", async (t) => {
  const f = await fixture(t);
  for (const screen of ["lookalike", "trust", "unknown"]) {
    f.state.screen = screen;
    assert.deepEqual((await f.broker.list("auto")).requests, [], screen);
  }
  assert.deepEqual(f.keys, []);
});
test("a dialog that leaves the screen expires its request", async (t) => {
  const f = await fixture(t);
  const ask = (await f.broker.list("auto")).requests[0];
  f.state.screen = "composer";
  assert.deepEqual((await f.broker.list("auto")).requests, []);
  await assert.rejects(answer(f, ask, "accept"), { status: 409 });
  assert.deepEqual(f.keys, []);
});
test("before the receipt, folder trust below settings warnings is a trust request", async (t) => {
  const f = await fixture(t, { started: false });
  f.state.screen = "trust";
  f.state.selected = "exit";
  const ask = (await f.broker.list("auto")).requests[0];
  assert.equal(ask.presentation, "claudeFolderTrust");
  f.state.screen = "unknown";
  assert.equal((await f.broker.list("auto")).requests[0].subject.dialog, "unknown");
});
