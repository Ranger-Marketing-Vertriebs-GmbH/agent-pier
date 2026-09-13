import test from "node:test";
import assert from "node:assert/strict";
import { startupScreen } from "../../server/features/requests/claude-startup-prompts.js";
import { folderScreen } from "../fixtures/requests/claude-folder-trust.js";
import {
  apiKeyScreen,
  composerScreen,
  loginScreen,
  oauthScreen,
  permissionScreen,
  securityNotesScreen,
  themeLabels,
  themeScreen,
  unknownMenuScreen,
} from "../fixtures/requests/claude-startup-prompts.js";

const cwd = "/fixture/project";

test("theme selection exposes every style with the native selection", () => {
  const screen = startupScreen(themeScreen(), cwd);
  assert.equal(screen.dialog, "theme");
  assert.equal(screen.selected, "2");
  assert.deepEqual(
    screen.options.map((o) => o.label),
    themeLabels,
  );
  assert.deepEqual(
    screen.options.map((o) => o.id),
    ["1", "2", "3", "4", "5", "6", "7"],
  );
  assert.equal(startupScreen(themeScreen(3, { narrow: true }), cwd).selected, "3");
});
test("API key confirmation offers yes and no without exposing the key", () => {
  const screen = startupScreen(apiKeyScreen(), cwd);
  assert.equal(screen.dialog, "apiKey");
  assert.equal(screen.selected, "no");
  assert.deepEqual(
    screen.options.map((o) => o.id),
    ["yes", "no"],
  );
  assert.equal(JSON.stringify(screen).includes("probe-key"), false);
  assert.equal(startupScreen(apiKeyScreen("yes", { narrow: true }), cwd).selected, "yes");
});
test("security notes are a single continue step", () => {
  const screen = startupScreen(securityNotesScreen(), cwd);
  assert.equal(screen.dialog, "securityNotes");
  assert.equal(screen.selected, "continue");
  assert.deepEqual(
    screen.options.map((o) => o.id),
    ["continue"],
  );
});
test("folder trust keeps its dedicated dialog and workspace check", () => {
  assert.deepEqual(startupScreen(folderScreen(cwd, "trust"), cwd), {
    dialog: "trust",
    selected: "trust",
    options: [
      { id: "trust", label: "Yes, I trust this folder", scope: "persistent" },
      { id: "exit", label: "No, exit" },
    ],
  });
  assert.equal(startupScreen(folderScreen("/other"), cwd), null);
});
test("login screens block chat but cannot be answered from chat", () => {
  for (const raw of [loginScreen(), oauthScreen()]) {
    const screen = startupScreen(raw, cwd);
    assert.equal(screen.dialog, "login");
    assert.deepEqual(screen.options, []);
    assert.equal(screen.selected, null);
  }
});
test("unknown startup menus are reported only before the native receipt", () => {
  const screen = startupScreen(unknownMenuScreen(), cwd, { started: false });
  assert.equal(screen.dialog, "unknown");
  assert.deepEqual(screen.options, []);
  assert.equal(startupScreen(unknownMenuScreen(), cwd, { started: true }), null);
  assert.equal(startupScreen(unknownMenuScreen(), cwd), null);
});
test("the composer and running permission prompts are not startup dialogs", () => {
  assert.equal(startupScreen(composerScreen(), cwd, { started: false }), null);
  assert.equal(startupScreen(permissionScreen(), cwd, { started: false }), null);
  assert.equal(startupScreen("", cwd, { started: false }), null);
  assert.equal(startupScreen(null, cwd, { started: false }), null);
  assert.equal(startupScreen("x".repeat(70000), cwd, { started: false }), null);
});
