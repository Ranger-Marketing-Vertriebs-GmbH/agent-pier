import test from "node:test";
import assert from "node:assert/strict";
import {
  splitToolActions,
  toolActions,
} from "../../web/features/dashboard/tool-actions.js";

const ids = (actions) => actions.map((action) => action.id);
const split = (tool) => {
  const { primary, more } = splitToolActions(toolActions(tool));
  return { primary: primary?.id ?? null, more: ids(more) };
};

test("a missing CLI installs; a missing shell is unavailable", () => {
  assert.deepEqual(ids(toolActions({ id: "codex", installed: false })), ["install"]);
  assert.deepEqual(ids(toolActions({ id: "shell", installed: false })), ["unavailable"]);
  assert.deepEqual(split({ id: "gh", installed: false, utility: true }), {
    primary: "install",
    more: [],
  });
});

test("an installed CLI starts first and keeps its update in the menu", () => {
  assert.deepEqual(split({ id: "codex", installed: true }), {
    primary: "start",
    more: ["update"],
  });
  assert.deepEqual(split({ id: "shell", installed: true }), {
    primary: "start",
    more: [],
  });
});

test("a CLI below its minimum version updates first, in warning tone", () => {
  const actions = toolActions({
    id: "claude",
    installed: true,
    versionStatus: "update-required",
  });
  assert.deepEqual(actions.at(-1), { id: "update", browser: false, required: true });
  assert.deepEqual(
    split({ id: "claude", installed: true, versionStatus: "update-required" }),
    {
      primary: "update",
      more: ["start"],
    },
  );
});

test("utilities: gh opens its credentials, nono updates, Chromium updates or removes", () => {
  assert.deepEqual(toolActions({ id: "gh", installed: true, utility: true })[0], {
    id: "credentials",
    page: "connections/github",
  });
  assert.deepEqual(split({ id: "nono", installed: true, utility: true }), {
    primary: "update",
    more: [],
  });
  assert.deepEqual(split({ id: "chromium", installed: true, utility: true }), {
    primary: null,
    more: ["remove"],
  });
  const browser = toolActions({
    id: "chromium",
    installed: true,
    utility: true,
    updateAvailable: true,
  });
  assert.deepEqual(browser, [
    { id: "update", browser: true, required: false },
    { id: "remove" },
  ]);
  assert.deepEqual(splitToolActions(browser).primary.id, "update");
});

test("the split keeps every action exactly once", () => {
  for (const tool of [
    { id: "codex", installed: true, versionStatus: "update-required" },
    { id: "chromium", installed: true, utility: true, updateAvailable: true },
    { id: "gh", installed: true, utility: true },
    { id: "opencode", installed: false },
  ]) {
    const actions = toolActions(tool);
    const { primary, more } = splitToolActions(actions);
    assert.deepEqual(
      [primary, ...more].filter(Boolean).sort((a, b) => a.id.localeCompare(b.id)),
      [...actions].sort((a, b) => a.id.localeCompare(b.id)),
    );
  }
});

test("every action has a grid label and a short label in both languages", async () => {
  const { setLanguage } = await import("../../web/lib/i18n/index.js");
  const view = await import("../../web/features/dashboard/tool-action-view.js");
  const tools = [
    { id: "codex", installed: true, versionStatus: "update-required" },
    { id: "codex", installed: true },
    { id: "shell", installed: false },
    { id: "opencode", installed: false },
    { id: "gh", installed: true, utility: true },
    { id: "nono", installed: true, utility: true },
    { id: "chromium", installed: true, utility: true, updateAvailable: true },
  ];
  for (const language of ["de", "en"]) {
    setLanguage(language, { persist: false, document: null });
    for (const tool of tools)
      for (const action of toolActions(tool)) {
        assert.match(view.toolActionLabel(action), /\S/, `${tool.id} ${action.id}`);
        assert.match(view.toolActionShortLabel(action), /\S/, `${tool.id} ${action.id}`);
        assert.doesNotMatch(view.toolActionShortLabel(action), /undefined/);
      }
  }
  setLanguage("de", { persist: false, document: null });
});
