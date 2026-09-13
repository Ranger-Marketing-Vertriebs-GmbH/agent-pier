import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { folderScreen } from "../fixtures/requests/claude-folder-trust.js";
import {
  apiKeyScreen,
  loginScreen,
  securityNotesScreen,
  themeScreen,
  unknownMenuScreen,
} from "../fixtures/requests/claude-startup-prompts.js";

/** A fake Claude onboarding: theme → API key → security notes → folder trust. */
async function fixture(t, { screens } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-onboarding-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const configDir = path.join(root, "profile");
  await fs.mkdir(configDir);
  const session = {
    id: "onboarding",
    tool: "claude",
    accountId: "one",
    status: "running",
    cwd,
    nativeRequests: { enabled: true },
    nativeBinding: { enabled: true },
  };
  const keys = [];
  const state = { step: 0, theme: 2, apiKey: "no", trust: "exit" };
  const render = screens || [
    () => themeScreen(state.theme),
    () => apiKeyScreen(state.apiKey),
    () => securityNotesScreen(),
    () => folderScreen(cwd, state.trust),
    () => "Normal chat composer",
  ];
  const broker = new RequestBroker({
    dataDir: root,
    sessions: {
      get: async () => session,
      control: async (_id, operation) =>
        operation({
          session,
          screen: async () => render[Math.min(state.step, render.length - 1)](),
          keys: async (values) => {
            keys.push(...values);
            for (const key of values) {
              const current = render[state.step];
              if (current === render[0]) {
                if (key === "Down") state.theme = Math.min(7, state.theme + 1);
                if (key === "Up") state.theme = Math.max(1, state.theme - 1);
              } else if (current === render[1]) {
                if (key === "Up") state.apiKey = "yes";
                if (key === "Down") state.apiKey = "no";
              } else if (current === render[3]) {
                if (key === "Down") state.trust = "trust";
                if (key === "Up") state.trust = "exit";
              }
              if (key === "Enter") state.step++;
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
    path.join(bindingDir, "onboarding.launch.json"),
    JSON.stringify(binding),
  );
  t.after(async () => {
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { broker, session, keys, state, binding, bindingDir };
}
const answer = (f, ask, choice) =>
  f.broker.answer("onboarding", ask.id, { expectedRevision: ask.revision, choice });

test("fresh profile onboarding is walked step by step from chat", async (t) => {
  const f = await fixture(t);
  const theme = (await f.broker.list("onboarding")).requests[0];
  assert.equal(theme.presentation, "claudeStartupPrompt");
  assert.equal(theme.kind, "permission");
  assert.equal(theme.subject.dialog, "theme");
  assert.equal(theme.options.length, 7);
  assert.equal(theme.launchIdentity, undefined);
  assert.equal(f.broker.hasPending("onboarding"), true);
  const afterTheme = await answer(f, theme, "4");
  assert.deepEqual(f.keys, ["Down", "Down", "Enter"]);
  assert.equal(afterTheme.requests[0].subject.dialog, "apiKey");
  assert.deepEqual(
    afterTheme.requests[0].options.map((o) => o.id),
    ["yes", "no"],
  );
  f.keys.length = 0;
  const afterKey = await answer(f, afterTheme.requests[0], "yes");
  assert.deepEqual(f.keys, ["Up", "Enter"]);
  assert.equal(afterKey.requests[0].subject.dialog, "securityNotes");
  f.keys.length = 0;
  const afterNotes = await answer(f, afterKey.requests[0], "continue");
  assert.deepEqual(f.keys, ["Enter"]);
  assert.equal(afterNotes.requests[0].presentation, "claudeFolderTrust");
  assert.equal(afterNotes.requests.length, 1);
  await assert.rejects(answer(f, theme, "1"), { status: 409 });
});
test("startup prompts reject unknown choices and vanish when the screen moves on", async (t) => {
  const f = await fixture(t);
  const theme = (await f.broker.list("onboarding")).requests[0];
  await assert.rejects(answer(f, theme, "9"), { status: 400 });
  await assert.rejects(answer(f, theme, "trust"), { status: 400 });
  assert.deepEqual(f.keys, []);
  f.state.step = 4;
  assert.deepEqual((await f.broker.list("onboarding")).requests, []);
  await assert.rejects(answer(f, theme, "1"), { status: 409 });
  assert.deepEqual(f.keys, []);
});
test("login and unknown menus are shown without chat answers until the receipt", async (t) => {
  const f = await fixture(t, {
    screens: [() => loginScreen(), () => unknownMenuScreen()],
  });
  const login = (await f.broker.list("onboarding")).requests[0];
  assert.equal(login.subject.dialog, "login");
  assert.deepEqual(login.options, []);
  await assert.rejects(answer(f, login, "1"), { status: 400 });
  f.state.step = 1;
  const unknown = (await f.broker.list("onboarding")).requests[0];
  assert.equal(unknown.subject.dialog, "unknown");
  assert.notEqual(unknown.id, login.id);
  await fs.writeFile(
    path.join(f.bindingDir, "onboarding.receipt.json"),
    JSON.stringify(f.binding),
  );
  assert.deepEqual((await f.broker.list("onboarding")).requests, []);
  assert.deepEqual(f.keys, []);
});
