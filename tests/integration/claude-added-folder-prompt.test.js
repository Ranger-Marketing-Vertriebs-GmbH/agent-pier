import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { addedFolderScreen } from "../fixtures/requests/claude-added-folder.js";

/**
 * A fake Claude terminal at its --add-dir trust dialog. Like Claude, it takes Enter on
 * "Yes, add it" only right after ↓.
 */
async function fixture(t, { started = false, shown } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-added-folder-"));
  const cwd = path.join(root, "project");
  const directory = path.join(root, "chat-attachments", "one", "added");
  await fs.mkdir(cwd);
  await fs.mkdir(directory, { recursive: true });
  const session = {
    id: "added",
    tool: "claude",
    accountId: "one",
    status: "running",
    cwd,
    attachments: { directory },
    nativeRequests: { enabled: true },
    nativeBinding: { enabled: true },
  };
  const keys = [];
  const state = { screen: "folder", selected: "exit", last: null };
  const render = {
    folder: () => addedFolderScreen(shown ?? directory, { selected: state.selected }),
    composer: () => "\n❯ \n",
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
        serial(() =>
          operation({
            session,
            screen: async () => render[state.screen](),
            keys: async (values) => {
              keys.push(...values);
              for (const key of values) {
                if (key === "Down") state.selected = "add";
                if (key === "Up") state.selected = "exit";
                if (
                  key === "Enter" &&
                  (state.selected === "exit" || state.last === "Down")
                )
                  state.screen = "composer";
                state.last = key;
              }
            },
          }),
        ),
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
  const binding = { id: session.id, accountId: "one", tool: "claude", cwd, token: "b" };
  await fs.writeFile(path.join(bindingDir, "added.launch.json"), JSON.stringify(binding));
  if (started)
    await fs.writeFile(
      path.join(bindingDir, "added.receipt.json"),
      JSON.stringify(binding),
    );
  t.after(async () => {
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { broker, directory, keys, state };
}
const answer = (f, ask, choice) =>
  f.broker.answer("added", ask.id, { expectedRevision: ask.revision, choice });

test("the attachment folder's trust dialog is answered from chat", async (t) => {
  for (const started of [false, true]) {
    const f = await fixture(t, { started });
    const ask = (await f.broker.list("added")).requests[0];
    assert.equal(ask.presentation, "claudeStartupPrompt");
    assert.deepEqual(ask.subject, { dialog: "addedFolder", path: f.directory });
    assert.deepEqual(
      ask.options.map((o) => [o.id, o.label]),
      [
        ["exit", "No, exit"],
        ["add", "Yes, add it"],
      ],
    );
    assert.deepEqual((await answer(f, ask, "add")).requests, []);
    assert.deepEqual(f.keys, ["Down", "Enter"]);
  }
});

test("a preselected Yes is reached again with ↓ before Enter", async (t) => {
  const f = await fixture(t);
  f.state.selected = "add";
  const ask = (await f.broker.list("added")).requests[0];
  assert.deepEqual((await answer(f, ask, "add")).requests, []);
  assert.deepEqual(f.keys, ["Up", "Down", "Enter"]);
});

test("No, exit is sent as it is selected", async (t) => {
  const f = await fixture(t);
  const ask = (await f.broker.list("added")).requests[0];
  assert.deepEqual((await answer(f, ask, "exit")).requests, []);
  assert.deepEqual(f.keys, ["Enter"]);
});

test("a folder that is not the session's own stays unknown or unanswered", async (t) => {
  const before = await fixture(t, { shown: "/somewhere/else" });
  const unknown = (await before.broker.list("added")).requests[0];
  assert.equal(unknown.subject.dialog, "unknown");
  assert.deepEqual(unknown.options, []);
  const after = await fixture(t, { started: true, shown: "/somewhere/else" });
  assert.deepEqual((await after.broker.list("added")).requests, []);
  assert.deepEqual([...before.keys, ...after.keys], []);
});
