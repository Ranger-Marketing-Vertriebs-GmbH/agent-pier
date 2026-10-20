import test from "node:test";
import assert from "node:assert/strict";
import { startupScreen } from "../../server/features/requests/claude-startup-prompts.js";
import {
  folderScreen,
  folderScreenWithWarnings,
} from "../fixtures/requests/claude-folder-trust.js";
import {
  apiKeyScreen,
  autoModeBillingScreen,
  autoModeDefaultScreen,
  autoModeLookalikeScreen,
  composerScreen,
  loginScreen,
  oauthScreen,
  permissionScreen,
  securityNotesScreen,
  themeLabels,
  themeScreen,
  themeScreenV296,
  transcriptLookalikeScreen,
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
test("Claude 2.1.296 theme rows without numbers keep the native order and cursor", () => {
  for (const selected of [1, 2, 5]) {
    const screen = startupScreen(themeScreenV296(selected), cwd, { started: false });
    assert.equal(screen?.dialog, "theme");
    assert.equal(screen.selected, String(selected));
    assert.deepEqual(
      screen.options.map((o) => o.label),
      themeLabels,
    );
    assert.deepEqual(
      screen.options.map((o) => o.id),
      ["1", "2", "3", "4", "5", "6", "7"],
    );
  }
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
test("quoted onboarding phrases in a transcript never count as a startup dialog", () => {
  assert.equal(startupScreen(transcriptLookalikeScreen(), cwd, { started: true }), null);
  assert.equal(startupScreen(transcriptLookalikeScreen(), cwd, { started: false }), null);
});

test("a theme phrase without the standalone /theme hint line is not a theme dialog", () => {
  const raw = [
    " Choose the text style that looks best with your terminal",
    " To change this later, run /theme in the prompt",
    " ❯ Dark mode",
    "   Light mode",
  ].join("\n");
  assert.equal(startupScreen(raw, cwd), null);
});

test("folder trust below settings warnings is trust, not an unknown menu", () => {
  const screen = startupScreen(folderScreenWithWarnings(cwd, "exit"), cwd, {
    started: false,
  });
  assert.equal(screen.dialog, "trust");
  assert.equal(screen.selected, "exit");
});
test("the auto mode default prompt keeps Claude's own options, also after the receipt", () => {
  for (const options of [{ started: false }, { started: true, sessionOnly: true }]) {
    const screen = startupScreen(autoModeDefaultScreen("decline"), cwd, options);
    assert.equal(screen.dialog, "autoModeDefault");
    assert.equal(screen.selected, "decline");
    assert.deepEqual(screen.options, [
      { id: "accept", label: "Yes, set auto mode as my default permission mode" },
      { id: "decline", label: "No, keep manual mode" },
    ]);
  }
  assert.equal(
    startupScreen(autoModeDefaultScreen("accept", "accept edits"), cwd).options[1].label,
    "No, keep accept edits",
  );
  // Neither or both rows marked: no selection to work from.
  const raw = autoModeDefaultScreen("accept").replace("❯ Yes", "  Yes");
  assert.equal(startupScreen(raw, cwd), null);
});
test("the classifier billing notice is answered with Enter or Esc", () => {
  for (const variant of [{}, { boxed: true }, { gateway: true, boxed: true }]) {
    const screen = startupScreen(autoModeBillingScreen(variant), cwd, {
      sessionOnly: true,
    });
    assert.equal(screen?.dialog, "autoModeBilling", JSON.stringify(variant));
    assert.deepEqual(screen.keys, { continue: "Enter", cancel: "Escape" });
    assert.deepEqual(
      screen.options.map((o) => o.id),
      ["continue", "cancel"],
    );
  }
  const unfinished = autoModeBillingScreen().replace("Nothing breaks", "Something");
  assert.equal(startupScreen(unfinished, cwd, { sessionOnly: true }), null);
});
test("auto mode texts quoted in a transcript above the composer are no dialog", () => {
  for (const options of [{ started: false }, { sessionOnly: true }])
    assert.equal(startupScreen(autoModeLookalikeScreen(), cwd, options), null);
  // After the receipt, onboarding dialogs and unknown menus are not looked for.
  assert.equal(startupScreen(themeScreen(), cwd, { sessionOnly: true }), null);
  assert.equal(startupScreen(folderScreen(cwd), cwd, { sessionOnly: true }), null);
  assert.equal(startupScreen(unknownMenuScreen(), cwd, { sessionOnly: true }), null);
});
