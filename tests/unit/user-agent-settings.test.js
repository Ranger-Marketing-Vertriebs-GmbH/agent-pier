import test from "node:test";
import assert from "node:assert/strict";
import {
  editableFields,
  settingsPatch,
  settingsView,
} from "../../server/features/users/user-agent-settings.js";
import { validateDefinition } from "../../server/features/assistants/assistant-validation.js";

const own = (released = []) => ({
  id: "a",
  revision: 3,
  name: "Helper",
  avatar: null,
  instructions: "Be kind",
  capabilities: { memory: true, reminders: true, webSearch: false, browser: false },
  userAccess: { mode: "own", members: [{ userId: "u", level: "chat" }], released },
});
const shared = { ...own(), userAccess: { ...own().userAccess, mode: "shared" } };

test("the editable fields follow level and ownership", () => {
  assert.deepEqual(editableFields(own(), "chat"), []);
  assert.deepEqual(editableFields(own(), "personalize"), [
    "name",
    "avatar",
    "instructions",
  ]);
  assert.deepEqual(editableFields(own(), "extended"), [
    "name",
    "avatar",
    "instructions",
    "capabilities",
  ]);
  for (const level of ["chat", "personalize", "extended"])
    assert.deepEqual(editableFields(shared, level), []);
  assert.deepEqual(editableFields(own(), null), []);
});

test("the view shows only released capabilities", () => {
  const view = settingsView(own(["webSearch"]), "extended");
  assert.deepEqual(view, {
    revision: 3,
    fields: ["name", "avatar", "instructions", "capabilities"],
    values: {
      name: "Helper",
      avatar: null,
      instructions: "Be kind",
      capabilities: { webSearch: false },
    },
    level: "extended",
    shared: false,
    released: ["webSearch"],
  });
});

test("a patch keeps to the fields and the released capabilities", () => {
  const agent = own(["webSearch"]);
  assert.deepEqual(settingsPatch(agent, "personalize", { name: "Nova", avatar: "🦊" }), {
    name: "Nova",
    avatar: "🦊",
  });
  assert.deepEqual(
    settingsPatch(agent, "extended", { capabilities: { webSearch: true } }),
    { capabilities: { ...agent.capabilities, webSearch: true } },
  );
  const refused = (level, values, status, code) =>
    assert.throws(
      () => settingsPatch(agent, level, values),
      (error) => {
        assert.equal(error.status, status);
        if (code) assert.equal(error.code, code);
        return true;
      },
    );
  refused("chat", { name: "x" }, 403, "USER_LEVEL");
  refused("personalize", { capabilities: { webSearch: true } }, 403, "USER_LEVEL");
  refused("extended", { capabilities: { browser: true } }, 403, "USER_LEVEL");
  refused("extended", { capabilities: { webSearch: "yes" } }, 400);
  refused("extended", { shell: "full" }, 400);
  refused("extended", { mcpServers: [] }, 400);
  refused("extended", { whatever: 1 }, 403, "USER_LEVEL");
  refused("extended", [], 400);
});

test("an avatar is one grapheme or none", () => {
  assert.equal(validateDefinition({ avatar: "🦊" }, true).avatar, "🦊");
  assert.equal(validateDefinition({ avatar: "👩‍👩‍👧" }, true).avatar, "👩‍👩‍👧");
  assert.equal(validateDefinition({ avatar: null }, true).avatar, null);
  for (const avatar of ["ab", "", 3, "🦊🦊", "x".repeat(17)])
    assert.throws(() => validateDefinition({ avatar }, true), { status: 400 });
});
