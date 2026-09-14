import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { folderScreen } from "../fixtures/requests/claude-folder-trust.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-startup-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const configDir = path.join(root, "profile");
  await fs.mkdir(configDir);
  const session = {
    id: "folder",
    tool: "claude",
    accountId: "one",
    status: "running",
    cwd,
    nativeRequests: { enabled: true },
    nativeBinding: { enabled: true },
  };
  const keys = [];
  let selected = "exit",
    screen = null;
  const broker = new RequestBroker({
    dataDir: root,
    sessions: {
      get: async () => session,
      control: async (_id, operation) =>
        operation({
          session,
          screen: async () => screen ?? folderScreen(cwd, selected),
          keys: async (values) => {
            keys.push(...values);
            for (const key of values) {
              if (key === "Down") selected = "trust";
              if (key === "Up") selected = "exit";
              if (key === "Enter") {
                screen = "next native screen";
                if (selected === "trust")
                  await fs.writeFile(
                    path.join(configDir, ".claude.json"),
                    JSON.stringify({
                      projects: { [cwd]: { hasTrustDialogAccepted: true } },
                    }),
                  );
              }
            }
          },
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
      env: { CLAUDE_CONFIG_DIR: configDir },
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
  await fs.writeFile(
    path.join(bindingDir, "folder.launch.json"),
    JSON.stringify(binding),
  );
  t.after(async () => {
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    broker,
    session,
    keys,
    binding,
    bindingDir,
    setScreen: (value) => (screen = value),
  };
}
test("folder approval is discovered before hooks, preserves privacy and submits once", async (t) => {
  const f = await fixture(t);
  const ask = (await f.broker.list("folder")).requests[0];
  assert.equal(ask.presentation, "claudeFolderTrust");
  assert.equal(ask.subject.path, f.session.cwd);
  assert.equal(ask.launchIdentity, undefined);
  assert.equal(ask.local, undefined);
  assert.equal(f.broker.hasPending("folder"), true);
  assert.deepEqual(
    (await f.broker.answer("folder", ask.id, { expectedRevision: 1, choice: "trust" }))
      .requests,
    [],
  );
  assert.deepEqual(f.keys, ["Down", "Enter"]);
  await assert.rejects(
    f.broker.answer("folder", ask.id, { expectedRevision: 1, choice: "trust" }),
    { status: 409 },
  );
});
test("started sessions cannot turn transcript lookalikes into actionable trust", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    path.join(f.bindingDir, "folder.receipt.json"),
    JSON.stringify(f.binding),
  );
  assert.deepEqual((await f.broker.list("folder")).requests, []);
  assert.deepEqual(f.keys, []);
});
test("Terminal handling and account replacement expire the folder request without input", async (t) => {
  const f = await fixture(t);
  const ask = (await f.broker.list("folder")).requests[0];
  f.setScreen("Normal chat composer");
  assert.deepEqual((await f.broker.list("folder")).requests, []);
  await assert.rejects(
    f.broker.answer("folder", ask.id, { expectedRevision: 1, choice: "trust" }),
    { status: 409 },
  );
  assert.deepEqual(f.keys, []);
  f.setScreen(null);
  const second = (await f.broker.list("folder")).requests[0];
  f.session.accountId = "changed";
  await assert.rejects(
    f.broker.answer("folder", second.id, { expectedRevision: 1, choice: "trust" }),
    { status: 409 },
  );
  assert.deepEqual(f.keys, []);
});
